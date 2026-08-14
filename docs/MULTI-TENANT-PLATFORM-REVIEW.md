# Multi-tenant platform review

**Status:** historical planning review (2026-08-12). **Current integration:** [INTEGRATION.md](../INTEGRATION.md). **Roadmap:** [MTDD-ROADMAP.md](MTDD-ROADMAP.md).

This document is not the implementation spec. Fan-out without tid, gRPC QueryStream, and `--require register` were revoked.

This document answers:

1. How is a **tenant** wired for routing (without the app knowing shards)?
2. How do we support **raw SQL and ORM parameterized queries** without named prepared statements?
3. Should **mtdd_server** manage Postgres (replication, failover)?
4. What **HA / replication** policy fits “two write servers” (**repmgr**, not Patroni/etcd)?
5. What **idempotency** and **reject-if-not-sure** policy applies across outages and promotions?

**Rule used throughout:** keep MTDD a thin data plane; DevOps owns Lookup and cluster layout; the app owns DDL/migrations and only knows the **Sharder-Key**.

---

## Feedback incorporated (2026-08-12)

| Feedback | Decision in this doc |
|----------|----------------------|
| Use **repmgr** instead of Patroni and etcd | Cluster plane = **repmgr** (+ `repmgrd`) for primary/standby failover. No etcd/Patroni. |
| App is **not** aware of `hostIndex` | App only knows **Sharder-Key** (SHA-256). DevOps owns Lookup and `hostIndex` ↔ shard layout. |
| Finalize **new Sharder-Key creation** tomorrow | Open decision — see §8. Documented as a hard blocker for the control contract. |
| **Idempotency** + **reject if not sure** | Driver: never retry unknown DML; fail closed. App: idempotency keys if *they* choose to retry. |

---

## Executive recommendation

| Question | Recommendation |
|----------|----------------|
| Tenant / routing identity | App passes **Sharder-Key** (SHA-256) only. Lookup (DevOps) maps key → `hostIndex`. App never sees or sets `hostIndex`. |
| DDL / migrations | **Application** concern. MTDD does not CREATE or migrate. |
| ORM / parameterized SQL | Accept `{ text, values }`; **ignore `name` when `text` is present**; still reject name-only execute. |
| Should mtdd_server manage DB servers? | **No.** Connections, execute, stream. HA = **repmgr**. |
| Two write servers | **One primary + one standby per shard** via repmgr (not two simultaneous primaries). |
| Uncertain write outcome | **Reject if not sure** — do not retry DML after unknown gRPC/commit outcome. |

```
  APP CONCERN                    DATA PLANE (ours)              CLUSTER / OPS (DevOps)
  ────────────                   ─────────────────              ─────────────────────
  CREATE / migrate               @advcomm/mtdd                  repmgr + repmgrd
  Sharder-Key on each query      Lookup HTTP  ◀── DevOps        nginx (gRPC TLS)
  Idempotency keys (optional)    mtdd_server_js                 PostgreSQL primary+standby
                                 DB_HOST / hostIndex (DevOps)   backups (pgBackRest/WAL-G)
```

---

## 0. Who knows what

| Actor | Knows | Does not know / own |
|-------|-------|---------------------|
| **Application** | Sharder-Key (SHA-256), SQL, DDL/migrations, optional idempotency keys | `hostIndex`, shard IPs, Lookup internals, repmgr topology |
| **DevOps** | `DB_HOST`, Lookup config, Sharder-Key → `hostIndex` mapping, repmgr, nginx | App business DDL (except platform standards they impose) |
| **mtdd (driver)** | Sharder-Key on the query → Lookup → `hostIndex` → gRPC | Creating keys, editing Lookup catalog, failover |
| **mtdd_server** | Local Postgres, QueryStream | Placement, Lookup, cluster election |

```
  App                    DevOps Lookup                 Shard VMs
  ───                    ────────────                  ─────────
  pool.query({           POST { sharderKey }           hostIndex 0, 1, …
    text, values,          → { hostIndex }             (app never sees this)
    tid: sharderKey   ──▶
  })
```

Today’s client field is still named `tid` in code. Product language: treat it as the **Sharder-Key**. Rename is optional later; contract matters more than the identifier string.

---

## 1. Tenant onboarding and Lookup (DevOps-owned)

### What exists today

Lookup: `POST { tid }` → `{ hostIndex }`. No create API in MTDD. Placement is outside the driver.

### Corrected ownership

1. **App** provisions tenant storage (schema/db/RLS + migrator) — not MTDD.
2. **DevOps** (or a DevOps-controlled Lookup) records **Sharder-Key → hostIndex**.
3. **App** only ever sends the Sharder-Key on queries (via `tid` / context today).
4. **mtdd** calls Lookup; never invents a shard.

```
  App onboarding                         DevOps
  ──────────────                         ──────
  1. Create tenant business row          3. Register Sharder-Key → hostIndex
  2. CREATE / migrate on the right       4. Operate Lookup + DB_HOST
     shard (DevOps tells them *which*
     environment / connection to use
     for bootstrap — not hostIndex
     in app code)

  Runtime: App → mtdd(Sharder-Key) → Lookup → hostIndex → mtdd_server
```

The app must **not** pick or store `hostIndex`. If bootstrap SQL must land on a specific shard, DevOps provides a **bootstrap path** (runbook, admin connection, or Lookup-side provision tooling) — still without baking `hostIndex` into application source.

Until Lookup has the key, Lookup returns **404 / not found**. No guess-on-first-query.

### Isolation modes

Still an **application** choice (schema / database / RLS). MTDD only needs Lookup to resolve a key to a shard.

### What MTDD must not do

- Auto-create tenants on first query
- Run DDL or migrators
- Expose or require `hostIndex` in application APIs
- Let the app write Lookup mappings

---

## 2. Sharder-Key (open — finalize tomorrow)

**Status:** design to be finalized **2026-08-13**.

### What we already know

- Identity the **app** uses for routing is a **Sharder-Key**, presented as a **SHA-256** value (hex or raw bytes — TBD).
- DevOps Lookup maps that key → `hostIndex`.
- App is unaware of `hostIndex`.

### Questions to close tomorrow

| # | Question | Why it matters |
|---|----------|----------------|
| K1 | What is hashed? (tenant UUID, org id, email domain, composite…)? | Stability + PII |
| K2 | Encoding of the key on the wire (`tid` string = hex SHA-256)? | Client + Lookup contract |
| K3 | Who mints the key — app at signup, or DevOps/Lookup? | Onboarding flow |
| K4 | Is the key immutable for the life of the tenant? | Remap / reshard |
| K5 | Fan-out queries (no key) still allowed for global/reference SQL? | Existing MTDD behavior |
| K6 | Cache key in mtdd = exact Sharder-Key string? | `MTDD_LOOKUP_CACHE_TTL_MS` |

Until K1–K4 land, do not implement a new register API or rename `tid` in code.

---

## 3. Parameterized queries and ORMs

### Policy (unchanged intent)

| Incoming | Policy |
|----------|--------|
| `text` + `values`, no `name` | Keep |
| `text` + `values` + `name` | **Strip `name`**, execute as unnamed `PQexecParams` |
| `name` only | Reject |
| Prisma engine / Parse–Bind–Execute | Out of v1 |

Robustness: OID/`types` fixtures, arrays/Date/JSON/bigint goldens, Knex/Sequelize CI, clearer classify errors for ORM SQL.

---

## 4. Should mtdd_server manage database servers?

**No.**

| Concern | Owner |
|---------|--------|
| `pg` pool, `session_id`, cursors, RPGB | **mtdd_server** |
| Streaming replication, promote standby | **repmgr** / **repmgrd** |
| TLS to clients | **nginx** |
| Backups | **pgBackRest** or WAL-G |
| Optional pooler in front of Postgres | PgBouncer **session** mode only |

Keep the shard agent local (`MTDD_PG_HOST=127.0.0.1`). After repmgr promotes, Postgres on that role still serves local connections; DevOps keeps `DB_HOST` / VIP pointed at the current primary write endpoint.

---

## 5. HA with repmgr (“two write servers”)

### Meaning

| Meaning | Verdict |
|---------|---------|
| Two **shards**, each writable | Already MTDD (`DB_HOST` + Lookup) |
| Per shard: **primary + standby**, promote on failure | **Adopt — repmgr** |
| Two **simultaneous primaries** of the same data | **Reject** |

### Topology (per shard)

```
  Node A (primary)                 Node B (standby)
  PostgreSQL + repmgr + repmgrd    PostgreSQL + repmgr + repmgrd
  mtdd_server (unix)               mtdd_server idle or follow promote
  nginx                            nginx
         ▲                                ▲
         └──── DB_HOST[i].write (VIP) ────┘

  No etcd. No Patroni.
```

**repmgr** (2ndQuadrant / EDB lineage) manages replication registration, `repmgrd` monitoring, `promote_command` / `follow_command`. Use explicit systemd service commands in `repmgr.conf`, `--upstream-node-id=%n` on follow, and `pg_rewind`-ready settings (`wal_log_hints`) so a demoted primary can rejoin.

**Ops notes (DevOps):**

- Prefer a **write VIP** (or update `DB_HOST[].write` after promote) so apps never chase hostIndex.
- `failover=automatic` only after fencing/runbook for the old primary (avoid split-brain on network partition — repmgr is not a Raft DCS; operational discipline matters).
- Regular failover drills.
- Sync vs async replication: product RPO choice (see §8).

### What we will not build in mtdd_server

- Replication slots, basebackup, auto-promote
- Consensus among shard agents
- Cross-shard 2PC

---

## 6. Idempotency and reject-if-not-sure

### Problem

Default `MTDD_GRPC_MAX_RETRIES` can retry after a write whose commit is **unknown** (stream died, failover mid-flight). That can **double-apply** mutations. Cluster tooling (repmgr) does not dedupe SQL.

### Policy: reject if not sure

```
  Outcome known OK     → return result
  Outcome known fail   → return error (app may retry if idempotent)
  Outcome UNKNOWN      → DO NOT RETRY in the driver
                         surface a clear error (e.g. uncertain outcome)
                         app decides: stop, or retry ONLY with idempotency key
```

| Command | Driver behavior on UNAVAILABLE / timeout after send started |
|---------|---------------------------------------------------------------|
| `SELECT` (read-only) | May retry |
| `INSERT` / `UPDATE` / `DELETE` / `CALL` / DML | **No retry** — **reject if not sure** |
| `BEGIN` / pinned session | **No retry** — session likely dead |
| Connect / Lookup | Retry with backoff (no mutation yet) |

Until the driver enforces this, operators should treat write paths as unsafe under default retries (`MTDD_GRPC_MAX_RETRIES=0` for write-heavy services).

### Application layer (when the app *chooses* to retry)

```sql
PRIMARY KEY (sharder_key, idempotency_key)  -- or tenant business key
```

Second insert → unique violation → return prior result. That is **app** ownership, not a gRPC request-id cache on mtdd_server (caches die on promote).

### During promote

| Event | Owner |
|-------|--------|
| repmgr promote / follow | DevOps / cluster |
| Unknown QueryStream after timeout | Driver rejects; app idempotency if retrying |
| LISTEN/NOTIFY coordinator restart | Clients resubscribe; not exactly-once |

---

## 7. Target picture

```
  App ── Sharder-Key + SQL ──▶ mtdd ──▶ Lookup (DevOps)
                                      │
                                      ▼ hostIndex
                                 nginx → mtdd_server → Postgres (repmgr pair)
```

**Breeze for app teams:** pass Sharder-Key, write normal SQL/`pg`, no shard math.  
**Breeze for DevOps:** Lookup + `DB_HOST` + repmgr runbooks; apps cannot mis-point `hostIndex`.

---

## 8. Suggested workstreams

| ID | Plane | Work | Depends on |
|----|-------|------|------------|
| K0 | Control | **Finalize Sharder-Key creation** (tomorrow) | — |
| T1 | Data | Strip `name` when `text` present | — |
| T2 | Data | ORM param golden tests | T1 |
| T3 | Data | **Reject-if-not-sure** — no DML retry on unknown outcome | — |
| L1 | Ops | Document Lookup contract: Sharder-Key in → `hostIndex` out; DevOps-only admin | K0 |
| H1 | Cluster | repmgr primary+standby reference (one shard) | — |
| H2 | Cluster | Write VIP / `DB_HOST` update on promote | H1 |
| I1 | App guidance | Idempotency key recipe (optional, for app retries) | T3 |

---

## 9. Decisions

| # | Topic | Status |
|---|-------|--------|
| D1 | HA = **repmgr**, not Patroni/etcd | **Accepted** (2026-08-12) |
| D2 | App never sees `hostIndex`; only Sharder-Key | **Accepted** (2026-08-12) |
| D3 | Lookup / catalog admin = **DevOps** | **Accepted** (2026-08-12) |
| D4 | Reject-if-not-sure for unknown DML | **Accepted** (2026-08-12) |
| D5 | Sharder-Key minting algorithm | **Open — finalize 2026-08-13** |
| D6 | Sync vs async replication under repmgr | Open (RPO vs latency) |
| D7 | Fan-out without Sharder-Key still allowed? | Open (keep today’s “no tid = fan-out” unless revoked) |

DDL isolation mode remains an **app** decision.

---

## 10. References

- Client routing: `src/query-executor.ts`, `src/lookup-client.ts`, `src/host-config.ts`
- Named-query reject: `src/normalize.ts` (`assertPlainSqlQuery`)
- gRPC retries: `src/grpc-policy.ts` (`isRetryableGrpcError`) — to be tightened under T3
- Server: `mtdd_server_js` `mtdd-shard-service.ts`, `streaming-query.ts`
- Consumer integration: [INTEGRATION.md](../INTEGRATION.md)

External: [repmgr](https://www.repmgr.org/), nginx gRPC, pgBackRest/WAL-G. App migrators cited only as **application** tooling.

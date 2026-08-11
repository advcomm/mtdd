# Multi-tenant platform review

**Status:** planning review (not an implementation spec)  
**Date:** 2026-08-11  
**Scope:** `@advcomm/mtdd` (query router) + `@advcomm/mtdd_server_js` (shard agent) + neighbouring control/cluster planes  
**Audience:** product + engineering deciding how to make tenant setup a breeze without turning the driver into a database orchestrator

This document answers the questions raised after the architecture explore:

1. How is a **tenant created**?
2. How do we support **raw SQL and ORM parameterized queries** without named prepared statements?
3. Should **mtdd_server** manage Postgres (replication, failover)?
4. What **HA / replication** policy fits “two write servers” and stays operable?
5. What **idempotency / deduplication** is required across outages and promotions?

**Rule used throughout:** use battle-tested open source for cluster and catalog problems; keep MTDD a thin, boring data plane.

---

## Executive recommendation

| Question                              | Recommendation                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant creation                       | **Directory only:** catalog + Lookup (`tid` → shard). `CREATE` / schema migrations are the **application’s** job, not MTDD’s.                                                           |
| ORM / parameterized SQL               | **Accept** `{ text, values }` **from ORMs; ignore** `name` **when** `text` **is present; still reject name-only execute.** Do not implement Parse/Bind/Execute in v1.                   |
| Should mtdd_server manage DB servers? | **No.** It keeps connections, runs SQL, streams results. Cluster life belongs to **Patroni + etcd + nginx**.                                                                            |
| Two write servers                     | Treat as **one primary + one hot standby per shard** (Patroni), not two simultaneous primaries of the same data. Client already supports `{ write, read: [] }` per shard.               |
| Idempotency                           | **Do not retry non-idempotent writes** at the gRPC layer after an unknown outcome. App/API **idempotency keys** + unique constraints. Patroni handles timeline rewind, not query dedup. |

```
  APP CONCERN (not MTDD)           DATA PLANE (ours)               CLUSTER PLANE (ops, not mtdd)
  ──────────────────────           ─────────────────               ────────────────────────────
  CREATE SCHEMA / DATABASE         @advcomm/mtdd                   Patroni (primary/replica)
  Atlas / Flyway / any migrator    Lookup HTTP  ◀── catalog        etcd quorum (3 nodes)
  Tenant business onboarding       mtdd_server_js                  nginx (gRPC TLS)
                                   Catalog (tid → shard)           watchdog / fencing
                                   PostgreSQL (local)
```

**CREATE, migrate, and tenant DDL are application concerns.** MTDD only needs to know which shard a `tid` maps to after the app has provisioned it.

If a component is not on that diagram, it should not grow into one of those boxes.

---

## 0. Three planes (do not mix)

Industry practice for multi-tenant data products (Citus Cloud, RDS Proxy + app routers, Vitess) is the same split:

| Plane           | Job                                                                 | Lives in                               |
| --------------- | ------------------------------------------------------------------- | -------------------------------------- |
| **Application** | `CREATE` schema/db, run migrations, onboard the tenant              | The consuming app (Atlas/Flyway/etc.)  |
| **Control**     | Assign shard, record `tid` → `hostIndex`, serve Lookup              | Catalog + Lookup (optional Tenant API) |
| **Data**        | Route this query, execute SQL, stream bytes                         | `mtdd` + `mtdd_server` + Lookup        |
| **Cluster**     | Replication, failover, fencing, backups                             | Patroni, etcd, WAL-G/pgBackRest, nginx |

`mtdd_server` today matches the data-plane box: Connect, QueryStream, Disconnect, optional in-memory notify. Expanding it into Patroni-class HA would compete with tools that already exist and would make every shard agent a snowflake.

---

## 1. Tenant creation

### What exists today

Lookup is a **read** API: `POST { tid }` → `{ hostIndex }`. There is no create/delete/migrate tenant API in either package. Placement policy is **outside** the driver (by design).

`tid` on a query is routing metadata only; it is not sent to Postgres. Nothing in the driver `CREATE`s a database or schema.

### Recommended model: directory only — app provisions

Treat a tenant as a **catalog row**, not as “first query that happens to include a tid.”

**The application** creates the schema/database and runs migrations with whatever it already uses (Atlas, Flyway, Prisma migrate, raw SQL, …). **MTDD does not run DDL or migrators.**

After the app has a place for that tenant’s data, it **registers** the mapping so Lookup can route:

```
  App / billing / signup
            │
            ├─ 1. (APP) Pick a shard if the app owns placement,
            │         or ask Lookup/catalog for a recommended hostIndex
            ├─ 2. (APP) CREATE SCHEMA / DATABASE / RLS — app’s isolation model
            ├─ 3. (APP) Run migrations (Atlas, Flyway, etc.)
            ├─ 4. (OURS) PUT catalog  (tid, host_index, status=ready)
            └─ 5. Lookup starts returning hostIndex
```

Until step 4 commits, Lookup must return **404 / not found** (not a guessed shard). Guessing on first query is how you silently create split tenants.

Optional: a tiny Tenant/Lookup API that only **assigns and stores** `tid → hostIndex`. It must not `CREATE` or migrate.

### Isolation modes (application choice)

MTDD does not pick or implement these. Lookup only needs a `hostIndex`.

| Mode                      | What the **app** runs                                         | When apps typically use it                                 |
| ------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| **A. Schema-per-tenant**  | `CREATE SCHEMA tenant_<tid>` + search_path or qualified names | Many small tenants, shared Postgres instance per shard     |
| **B. Database-per-tenant**| `CREATE DATABASE`                                             | Stronger isolation, fewer tenants, heavier ops             |
| **C. Row-level (`tid` + RLS)** | Shared schema; RLS policies                              | Simplest ops, weakest noisy-neighbour isolation            |

### Battle-tested tools

| Job               | Who        | Tool                                                                                         | Why                                    |
| ----------------- | ---------- | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| Schema migrations | **App**    | Atlas, Flyway, or whatever the app already uses                                              | Not an MTDD feature                    |
| Catalog store     | **Ours**   | PostgreSQL (small HA pair) or `mtdd_catalog` on an existing shard                            | Boring, backupable                     |
| Lookup            | **Ours**   | HTTP JSON; **read the catalog** (single source of truth)                                     | Don’t invent a second directory        |
| Placement         | **App** or optional catalog helper | Least-tenant-count, or jump-hash of `tid`                                    | Hash is simpler; least-count for skew  |

**Do not** use Citus / Vitess unless the product goal becomes “one SQL cluster that hides shards.” That replaces MTDD’s routing story rather than completing it.

### Register tenant — success / failure (ours)

| Step fails                      | Policy                                           |
| ------------------------------- | ------------------------------------------------ |
| Catalog insert unique violation | Treat as **already registered** (idempotent PUT) |
| App DDL / migrate failed        | **App** retries; do not register; Lookup stays 404 |

**Delete / offboard:** `status=disabled` in catalog first (Lookup stops routing). Dropping schema/database is the **app’s** job after a grace period. Never disable-then-drop while the driver still caches `tid` (`MTDD_LOOKUP_CACHE_TTL_MS`, default 30s) if queries should fail closed.

### What `@advcomm/mtdd` and `mtdd_server` must not do

- Auto-create a tenant on first query
- Run DDL as a side effect of `pool.query`
- Ship or invoke Atlas / Flyway / any migrator
- `CREATE SCHEMA` / `CREATE DATABASE` on behalf of the app
- Embed placement algorithms in `lookup-client.ts`

Optional later: Lookup/catalog admin HTTP so the app can `PUT /tenants/{tid}` with `hostIndex` — still no provisioner.

---

## 2. Parameterized queries and ORMs

### What exists today

Allowed:

```js
pool.query('SELECT * FROM t WHERE id = $1', [id]);
pool.query({text: 'SELECT * FROM t WHERE id = $1', values: [id]});
```

Rejected (client `assertPlainSqlQuery`, server `ensureQueryRequest`):

```js
pool.query({name: 'get_t', text: 'SELECT … $1', values: [id]});
pool.query({name: 'get_t', values: [id]}); // no SQL text
```

Wire is **PQexecParams-shaped**: `QueryRequest.text` + `params[]`, `name` must be empty, `result_format = 1`.

Retries: `MTDD_GRPC_MAX_RETRIES` (default 2) on UNAVAILABLE / DEADLINE_EXCEEDED / INTERNAL — including after writes whose outcome is unknown (see §5).

### The actual ORM gap

Most `pg`-based query builders (Knex, Sequelize `query()` + bind, Slonik, pg-promise) send **SQL text +** `$n` **values**. Many also set `name` as a plan-cache nickname. That nickname is useless on MTDD (the real connection lives in `mtdd_server`), but rejecting it **blocks the whole query**.

Engines that **do not** speak `pg.Pool.query` (Prisma’s query engine, some TypeORM driver modes) are a **different product**; do not promise them in v1.

### Recommended policy (compatible, standard)

Call this **unnamed parameterized SQL** (libpq `PQexecParams`). It is the industry default for pooled servers (PgBouncer transaction mode, RDS Proxy) because named prepares are connection-scoped.

| Incoming                              | Policy                                                   |
| ------------------------------------- | -------------------------------------------------------- |
| `text` + `values`, no `name`          | Keep (today)                                             |
| `text` + `values` + `name`            | **Strip** `name`**, execute as unnamed**                 |
| `name` only                           | Reject (cannot classify or route)                        |
| Query `name` used as Postgres PREPARE | Out of scope for v1                                      |
| ORM string concatenation (no `$n`)    | Works if AST-parseable; **do not encourage** (injection) |

Client and server must agree: if the client strips `name`, the server can keep rejecting non-empty `name` as a safety net.

### Make parameterized queries _robust_ (beyond stripping `name`)

These are the real compatibility bugs ORMs hit, in priority order:

1. `name` **strip** when `text` is present (unblocks Knex/Sequelize-style configs).
2. **Keep** `QueryConfig.types` **(OIDs)** on the wire — already partially mapped in `grpc-query-codec.ts`; add fixtures for `pg` `types` arrays.
3. **Arrays,** `Buffer`**,** `Date`**, JSON,** `bigint` — already encoded; add golden tests against ORM outputs, not only hand-written values.
4. `rowMode` — proto has `row_mode`; confirm ORM `array` vs `object` rows round-trip.
5. **Compatibility suite** (CI): Knex, Sequelize, `pg` QueryConfig, optional pg-promise. Each test: SELECT/INSERT with `$1`, `tid` set, mock gRPC.
6. **Classifier**: ORM SQL is often verbose (`"User" AS "User"`). AST path must keep working; unparseable SQL already throws `MtddSqlParseError` — surface a clear “ORM generated SQL we cannot classify” error rather than a parse dump.
7. **Do not** implement Parse/Bind/Execute RPCs until sessions + fan-out rules are designed. That is a major version, not an ORM checkbox.

### Non-goals for this track

- Prisma “just works”
- True prepared-statement reuse across the fleet
- Telling customers to rewrite as stored procedures (unnecessary if `text`+`$n` works)

---

## 3. Should mtdd_server manage database servers?

**No.**

Its documented job is: keep connections, execute queries, stream results (one shot or chunks). That matches `ConnectionManager`, `SessionStore`, `StreamingQuery`, RPGB encoder.

| Concern                                                    | Owner                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pg` pool, pinned `session_id`, cursors, RPGB              | **mtdd_server**                                                                                  |
| Streaming replication, promote replica, rewind old primary | **Patroni**                                                                                      |
| Leader lock / quorum                                       | **etcd** (3 nodes)                                                                               |
| Fence a partitioned primary                                | Patroni + Linux watchdog                                                                         |
| TLS to clients                                             | **nginx** (already)                                                                              |
| Backups                                                    | **pgBackRest** or WAL-G                                                                          |
| Connection pooling in front of Postgres                    | Optional **PgBouncer** in **session** mode only (transaction mode breaks `session_id` / cursors) |

Putting failover inside `mtdd_server` would mean re-implementing Patroni badly, and every QueryStream would need to understand timeline switches. Keep the shard agent **local and stupid**: `MTDD_PG_HOST=127.0.0.1` (or the Patroni primary via local socket / localhost).

**Failover visibility for MTDD:** after Patroni promotes, local Postgres is still on `127.0.0.1` **if** each VM runs one Postgres + one `mtdd_server`. The client’s `DB_HOST` IPs are **shard VMs** (nginx), not floating write VIPs inside the replica set. That is the simplest HA story.

If primary and replica are on **different** VMs, then either:

- run `mtdd_server` only on the current primary (Patroni callback / sidecar), or
- put a local HAProxy on each app path to the current primary,

…not a custom replicator inside the gRPC service.

---

## 4. HA, replication, and “two write servers”

### Ambiguity (resolve in product language)

“Two write DB servers” can mean three different architectures:

| Meaning                                                                                              | Verdict                                                        |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **S1.** Two **shards**, each writable (tenant A on 0, tenant B on 1)                                 | Already the MTDD model (`DB_HOST` array + Lookup)              |
| **S2.** Per shard: **one primary + one standby** (standby can be promoted → then it is _the_ writer) | **Recommended HA**                                             |
| **S3.** Two **simultaneous primaries** of the same data (multi-master / dual-write)                  | **Reject** for v1 — split-brain, conflict repair, not a breeze |

This review assumes the intent is **S2** (availability of writes) plus **S1** (scale-out by tenant). If the intent is S3, stop and choose BDR / Spock / pgEdge as a _different product_.

### Recommended per-shard topology

```
  Shard 0 VM A (primary)              Shard 0 VM B (replica)
  Patroni + Postgres                  Patroni + Postgres
  mtdd_server_js  (unix socket)       mtdd_server_js  OR idle until promote
  nginx :50051                        nginx :50051
         ▲                                   ▲
         └──────── client DB_HOST[0].write ──┘  (VIP or DNS to current primary)

  etcd: three nodes (not two). Watchdog on Postgres hosts.
```

**Patroni** is the industry default for Postgres HA (Percona, Zalando, many clouds’ spiritual cousin). It uses a DCS leader lock so **only one** node accepts writes.

**Two-node Postgres is OK; two-node etcd is not.** Quorum is `N/2+1`. Run **three etcd** nodes (cheap VMs or a shared etcd for all shards). Enable Patroni **watchdog** (`required`) so a wedged primary is fenced before another promote.

Client already models this:

```json
[
  {"write": "10.0.1.10", "read": ["10.0.1.11"]},
  {"write": "10.0.2.10", "read": ["10.0.2.11"]}
]
```

SELECTs can round-robin `read`; writes go to `write`. After failover, update `write` (or put a VIP on `write` and leave `DB_HOST` stable). Prefer a **VIP / DNS name behind the IP constraint** as a follow-up: today `DB_HOST` requires IPs, which fights floating VIPs unless the VIP is an IP.

### Policy that is robust _and_ easy

1. **Synchronous replication** (`synchronous_mode: true` in Patroni) if losing a committed write on failover is unacceptable. Cost: commit latency, replica must be up.
2. **Asynchronous** if RPO of a few seconds is acceptable. Easier ops, possible lost commits on crash.
3. **Never** dual-write the same tenant to both nodes “for HA.”
4. **mtdd_server** stays pointed at local Postgres; Patroni moves the _role_, not the query router.

### What we will not build in mtdd_server

- Replication slots, `pg_basebackup`, auto-promote
- Consensus (Raft) among shard agents
- Cross-shard two-phase commit

---

## 5. Idempotency and deduplication

### Why this is a real bug, not a slogan

Postgres **does not** deduplicate “the same INSERT sent twice.” Patroni **does not** either. Patroni prevents **two primaries**; it does not remember client queries.

The driver already retries gRPC `UNAVAILABLE` / `DEADLINE_EXCEEDED` / `INTERNAL` (default **2** retries). If a write was committed and the stream died before TRAILER, a retry **inserts twice**.

Failover window: client was talking to old primary; Patroni promotes replica; rewind/fence old primary. In-flight commits may be **lost** (async) or **unknown**. Retry without a key duplicates; no retry loses the user action.

### Layered policy (industry standard: Stripe/Twilio-style idempotency keys)

```
  API / app                 Driver                         Postgres
  ─────────                 ──────                         ────────
  Idempotency-Key on        Retry ONLY if                  UNIQUE (tid, idempotency_key)
  mutating requests         - Connect
                            - reads (SELECT)
                            - writes tagged idempotent
                            Do NOT retry unknown
                            INSERT/UPDATE/CALL
```

**Recommended driver change (later implementation):** classify retry safety:

| Command                                 | Retry on UNAVAILABLE after start?                         |
| --------------------------------------- | --------------------------------------------------------- |
| `SELECT` (no side effects)              | Yes                                                       |
| `INSERT` / `UPDATE` / `DELETE` / `CALL` | **No**, unless `req.idempotent === true` or SQL is tagged |
| `BEGIN` / session query                 | No (session may be dead; client must reconnect)           |

Until that ships, operators should set `MTDD_GRPC_MAX_RETRIES=0` for write-heavy apps, or accept duplicate risk.

### Application / schema contract (the actual dedup)

For every tenant-visible mutation that may be retried:

```sql
CREATE TABLE tenant_commands (
  tid text NOT NULL,
  idempotency_key text NOT NULL,
  -- payload / result as needed
  PRIMARY KEY (tid, idempotency_key)
);
```

Second insert of the same key → unique violation → return the original result. This is the standard, not a custom MTDD consensus protocol.

**Outbox** (optional): write business row + outbox event in one transaction; publisher is separate. Use if you emit side effects (email, notify). Tooling: app code first; Debezium only if you already run Kafka.

### During promote / consensus

| Event                               | Dedup owner                                                                |
| ----------------------------------- | -------------------------------------------------------------------------- |
| etcd leader lock, Patroni promote   | Cluster plane (not MTDD)                                                   |
| Old primary comes back              | Patroni `pg_rewind` / reinit as replica — **not** query replay             |
| Client reconnects after failover    | Lookup unchanged; `write` VIP should still hit new primary                 |
| Duplicate QueryStream after timeout | Idempotency key in **SQL/app**, not a gRPC request-id cache in mtdd_server |

A server-side “seen request id” cache is tempting and **wrong** across process restart and promote (the cache dies with the old primary). Put uniqueness in Postgres WAL.

### LISTEN/NOTIFY

In-memory registry on the coordinator is **not** durable. After coordinator restart, clients must resubscribe (client already reconnects Watch). Do not treat notify as an exactly-once bus.

---

## 6. Target architecture (automation that is actually a breeze)

```
  App onboarding
       │  CREATE / migrate (Atlas, Flyway, …)   ← not MTDD
       │  then register tid → hostIndex
       ▼
  Catalog Postgres ──read──▶ Lookup HTTP
       ▲
  App ─ mtdd ─ nginx ─ mtdd_server ─ Postgres primary (Patroni pair)
                         ─ (read) ── Postgres replica
```

**“Breeze” checklist:**

1. Ops: Patroni+etcd, nginx, mtdd_server per shard; Lookup + catalog.
2. App: provision tenant storage with **its** migrator, then register `tid` in the catalog.
3. App runtime: `--require @advcomm/mtdd/register`, `DB_HOST` JSON, `MTDD_LOOKUP_URL`.

---

## 7. Suggested workstreams (when implementation starts)

Ordered so we do not mix planes:

| ID  | Plane        | Work                                                                                           | Depends on |
| --- | ------------ | ---------------------------------------------------------------------------------------------- | ---------- |
| T1  | Data         | Strip `name` when `text` present; keep rejecting name-only; tests with Knex/Sequelize fixtures | —          |
| T2  | Data         | ORM param golden tests (types, arrays, dates); clearer classify errors                         | T1         |
| T3  | Data         | Retry policy: no automatic retry of unknown DML                                                | —          |
| C1  | Control      | Catalog schema + register/disable tenant (`tid` → `hostIndex`)                                 | —          |
| C2  | Control      | Lookup reads catalog only (`ready` tenants)                                                    | C1         |
| H1  | Cluster      | Patroni+etcd reference compose / systemd (one shard pair)                                      | —          |
| H2  | Cluster      | Document `DB_HOST` write VIP vs IP; optional read replicas                                     | H1         |
| H3  | Cluster      | Explicitly out of scope: dual-primary                                                          | —          |
| I1  | App guidance | Idempotency key recipe in docs + example table                                                 | T3         |

---

## 8. Decisions to confirm

These are product choices, not code facts:

1. **Does Lookup assign a shard**, or does the app pick `hostIndex` and we only store it?
2. **“Two write servers”** = Patroni pair (S2) or two shards (S1) or multi-master (S3)? This review assumes S1+S2.
3. **Sync vs async** replication (RPO vs latency)?
4. **Register API** as a small separate process vs “bring your own Lookup” (HTTP contract only)?

Isolation mode (schema vs database vs RLS) is **not our decision** — the app owns DDL.

---

## 9. References (in-tree)

- Client routing: `src/query-executor.ts`, `src/lookup-client.ts`, `src/host-config.ts`
- Named-query reject: `src/normalize.ts` (`assertPlainSqlQuery`)
- gRPC retries: `src/grpc-policy.ts` (`isRetryableGrpcError`)
- Server execute/stream: `mtdd_server_js/src/service/mtdd-shard-service.ts`, `src/pg/streaming-query.ts`
- Server name reject: `ensureQueryRequest` in `mtdd-shard-service.ts`
- Ops pairing: [OPERATIONS.md](OPERATIONS.md); companion server ops in `@advcomm/mtdd_server_js` `docs/OPERATIONS.md`

External: [Patroni](https://patroni.readthedocs.io/), etcd Raft quorum, pgBackRest/WAL-G, nginx gRPC, optional PgBouncer session mode. App migrators (Atlas, Flyway, …) are cited only as examples of **application** tooling.

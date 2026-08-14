# MTDD platform roadmap

Goal: MTDD is a **routing tool**. Given an opaque `tid` and a statement, it runs that statement on exactly one shard and returns the database’s native result. Placement lives in Lookup. Transport can change without changing those operations.

Consumers (pubkey, others) choose what `tid` *means*. The tool MUST NOT be specified from any one app’s stored procedures, preload flags, or schema.

Status: **Lookup binary-split is done. HAP PoC proxy (`SET mtdd.tid`) is implemented and covered by unit + Postgres integration tests.** Next: HAP lab e2e in this repo, then consumer switch, then (later) Rust/QUIC.

---

## Tool operations (non-negotiable)

1. **Bind tid** — opaque string on the wire: `SET mtdd.tid = '…'` then the statement. Apps normalize; MTDD does not. No placement math in business code.
2. **Place** — Lookup `POST /lookup` `{ tid }` → `{ hostIndex }`. Algorithm: **binary split** (`SHA-256` prefix, `hostIndex = digest & (N-1)`, `N = 2^k`). Not consistent-hash vnodes, not `sha256 % N` in the app, not `uuid_last_16_bits` unless Lookup itself is versioned to that digest.
3. **Execute** — exactly one shard. Any SQL the client sent (SELECT / INSERT / CALL / ORM). Not CALL-only.
4. **Return** — native Postgres on the same client session.
5. **Reuse** — no new TLS (or TCP+PG startup) per query on the path between front VIP and shard. PoC: proxy backend **pools** to shard HAProxy. Prod inclination: long-lived **QUIC** between a small Rust client and a Rust agent that talks to Postgres on localhost.

Fail closed: missing tid, Lookup failure, or proxy not ready MUST error. No silent native fallback to `DB_HOST[i]:5432`.

**Not the tool:** what tid *means* (email vs tenant vs UUID), whether the app uses an ORM, HAProxy SQL parsing, gRPC QueryStream.

---

## Transports

```text
Legacy (discard):
  app --require register → JS tid → gRPC QueryStream → mtdd_server → PG

PoC / keep for a while:
  [PG client] → HAP GW (dumb TCP, pgsql-check)
             → mtdd-proxy (operations 1–5, pooled backends)
             → HAP shard[i] (dumb TCP, pgsql-check)
             → Postgres

Intended prod:
  [app + small Rust MTDD client]
        -- QUIC (multiplexed queries on a long-lived session) --
  [Rust MTDD agent on DB host] → Postgres localhost
```

gRPC is not required once the client speaks PG (PoC) or QUIC (prod). HAProxy never parses SQL. App `DB_HOST`/`DB_PORT` on the PoC path is **one GW VIP**, not a JSON array.

---

## Current state

| Piece | Status |
|-------|--------|
| Lookup HTTP + binary-split (`mtdd_lookup`) | **Done** — goldens: `tenant-c`→0, `tenant-a`→1 (N=2) |
| In-process `pg` patch + gRPC query | **Legacy** — `./register` fail-closed; `install()` only with `MTDD_LEGACY_INSTALL=1` (tests) |
| HAP routing proxy + `SET mtdd.tid` | **Done** — `npm run mtdd-proxy`; OpenSpec `ha-proxy-sp-tid-no-preload` applied; lab in `scripts/haproxy/` |
| Wire contract `SET mtdd.tid` | **Done** in the proxy (statement-scoped; tx pins until COMMIT) |
| App `DB_HOST` = single HAP VIP | **Done** as the supported integration (README / `.env.example`) |
| Rust QUIC client/agent | Later; same operations, different transport |
| Fan-out `tid: null` / SELECT merge | Dropped |
| Production TLS/QUIC runbooks | Not started |

---

## Phase 0 — Scope lock

**Owner:** platform  

- [x] Lookup lives in **mtdd-suite** (`mtdd_lookup`), shared, not inside an app repo.
- [x] Placement = binary-split; `SHARD_COUNT` power of 2; digest change = new epoch.
- [x] Tid normalization is **app-side**; Lookup hashes bytes as received.
- [x] Wire tid = `SET mtdd.tid` (helpers/adapters are DX, not a `pg` preload).
- [x] App `DB_HOST` on PoC = single HAP VIP; shard list is proxy config aligned with Lookup `SHARD_COUNT`.

---

## Phase 1 — Lookup (done)

Binary-split Lookup is the placement brain. Do **not** replace it with consistent-hash vnodes unless a later epoch explicitly says so.

Contract (frozen):

- `GET /health` → `{ ok, shardCount, … }`
- `POST /lookup` `{ tid }` → `{ hostIndex }` in `[0, N)`
- Opaque tid; `tenant-a`/`tenant-b`/`tenant-c` goldens in `mtdd_lookup` README

Apps and the proxy are Lookup **clients**. They do not embed the digest.

---

## Phase 2 — HAProxy PoC (done)

**Owner:** mtdd (`ha-proxy-sp-tid-no-preload`)  

Implemented:

- GW HAP → proxy → shard HAP → PG (`scripts/haproxy/`)
- `SET mtdd.tid` + ordinary SQL (`src/proxy/`)
- Integration: Lookup goldens `tenant-c`→0 / `tenant-a`→1; row only on mapped shard
- Backend pool: two queries to the same shard reuse a connection (`/health` metrics)
- `./register` fail closed

Exit: vanilla `pg` against the GW VIP (or proxy port) routes `tenant-c` / `tenant-a` correctly.

Consumers (pubkey or others) switch **after** this PoC: drop preload, point at VIP, emit SET (or a helper). A consumer UUID is just a tid **string** Lookup will hash; do not retarget Lookup to `uuid_last_16_bits` for one app.

---

## Phase 3 — Consumer helpers and smoke

**Owner:** each app. Copy-paste SET helpers: [INTEGRATION.md](../INTEGRATION.md) (not a `pg` preload).  

- Helper: `withTid(tid, sql, params)` → SET + statement. Not a driver patch.
- Optional later: Prisma/Drizzle/Knex adapters that emit SET.
- App smokes: unique tids, stickiness, isolation, Lookup vector assert — **using that app’s tid format**, against the VIP.

Still out of core MTDD: Redis, SMTP, OTP, doctor CLI.

---

## Phase 4 — Prod transport (Rust / QUIC)

**Owner:** platform / mtdd  

Same operations. Replace HAP-HAP data path with:

- Small Rust client in (or beside) the app
- QUIC to Rust agent on the DB host
- Agent queries Postgres on **localhost**
- Long-lived QUIC session; queries multiplexed; **no per-query TLS**

HAP may remain a VIP in front of clients or agents; it still does not parse SQL.

Exit: written OPERATIONS (env, readiness, pool/QUIC session expectations, don’ts).

---

## Phase 5 — Reshard and ops

- Ring/epoch membership with controlled key move (duplicate → prune), using the **same** `hostIndexForTid` as Lookup.
- Metrics: lookup latency, hostIndex skew, backend pool vs query rate, QUIC session errors.
- Authn/z on Lookup.

---

## Implementation order

| Step | Work | Repo |
|------|------|------|
| **Done** | Binary-split Lookup + HTTP contract | `mtdd_lookup` |
| **Done** | HAP PoC proxy + SET tid + golden tests | `mtdd` |
| **Next** | Consumers drop register; VIP + SET/helper | each app |
| **Later** | Rust QUIC client + agent | mtdd / suite |
| **Later** | OPERATIONS + reshard | suite |

---

## Open decisions

1. Autocommit tid = next statement only vs until idle timeout — **locked: next statement**; tx pins until COMMIT.
2. PoC lab: plain TCP pools first vs TLS on HAP backends from day one — **locked: TCP first** (reuse proven); TLS on the same pools when ops wants it.
3. Package layout for the proxy binary vs today’s `@advcomm/mtdd` client package (`npm run mtdd-proxy` ships in this package for now).
4. When to start Rust/QUIC vs living on HAP-HAP (lead: PoC HAP now, **may keep it for some time**).

---

## Success metrics

- Tool: bind → lookup → one shard → native result, for **any** SQL with a tid.
- Local PoC: Lookup goldens through HAP GW match `hostIndex` 0/1; backend connections are reused.
- Architecture: zero placement algorithms in apps; zero gRPC on the query path; Lookup digest unchanged unless a new epoch.

## 1. Lab harness (HAProxy + Lookup + vanilla pg)

- [x] 1.1 Add `scripts/haproxy/` (cfg + run notes): GW VIP → proxy listen port; per-shard VIP → Postgres; `option pgsql-check` only; note TLS is optional and must use the proxy’s backend pool when enabled
- [x] 1.2 Wire Lookup (`mtdd_lookup`) with `SHARD_COUNT=2` beside the proxy (`MTDD_LOOKUP_URL`)
- [x] 1.3 Vanilla-`pg` probe: `SET mtdd.tid` + SQL (not `--require`); assert native result through the GW VIP
- [x] 1.4 Prove HAProxy session logs still lack SQL/params/tid

## 2. Proxy process (operations)

- [x] 2.1 Add `mtdd-proxy` entry: bind/port, `MTDD_LOOKUP_URL`, `MTDD_SHARD_HOSTS`, shard credentials, HTTP `/health`
- [x] 2.2 Accept Postgres startup/auth (v1 shared `DB_USER`/`DB_PASSWORD`)
- [x] 2.3 Intercept `SET mtdd.tid` / `RESET mtdd.tid`; strip or rewrite so Postgres does not need that GUC; bind opaque tid for the unit of work
- [x] 2.4 Reject data statements with missing/empty tid (no Lookup, no shard I/O)
- [x] 2.5 `POST /lookup` `{ tid }` → `hostIndex`; forward the **opaque** statement (SELECT/INSERT/CALL/…) on a **pooled** backend to that shard HAP; write native PG on the client socket
- [x] 2.6 Backend pool per shard: reuse connections; do not TCP/TLS/startup per query; expose a counter or log that queries can exceed new backend connects
- [x] 2.7 Pin client session to `hostIndex` until COMMIT/ROLLBACK; reject a tid that maps to another shard in the same transaction; autocommit tid does not stick to the next query

## 3. Drop the preloader and gRPC app path

- [x] 3.1 Make `./register` / `install()` fail closed (throw with migration text) or remove the export; drop JSON-array `DB_HOST` validation on app preload
- [x] 3.2 Update README and `.env.example`: app `DB_HOST`/`DB_PORT` = GW VIP; `SET mtdd.tid`; proxy owns shard list; no `--require`; no gRPC client for queries
- [x] 3.3 Document: tool operations (bind/place/execute/return/reuse); SQL dialect is the app’s; fan-out/merge gone; QUIC client/agent is a later **transport** with the same operations

## 4. Tests (binary-split e2e)

- [x] 4.1 Unit: SET extraction, reject missing/empty tid, Lookup hostIndex bounds, autocommit tid does not leak
- [x] 4.2 Integration: `tenant-c` → hostIndex `0` and `tenant-a` → hostIndex `1` (`SHARD_COUNT=2` Lookup goldens) via SET + write/read through the GW VIP; row exists only on the mapped shard
- [x] 4.3 Integration: `SELECT 1` without SET returns a Postgres error and never hits a shard
- [x] 4.4 Integration: two statements to the same shard reuse a backend connection (pool metric / HAP session count)

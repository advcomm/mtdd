## Context

MTDD’s product surface is a small set of **operations**, independent of any one app (pubkey, ORM, stored procs, raw SQL):

1. **Bind tid** — read an opaque tenant/routing key from the wire.
2. **Place** — `POST /lookup` `{ tid }` → `{ hostIndex }` (binary-split in `mtdd_lookup`).
3. **Execute** — run the client’s statement on exactly that shard.
4. **Return** — native Postgres messages on the same client session.
5. **Reuse** — backend connections to shards are pooled; a query is not a new TLS/TCP/PG-startup session.

This change implements those operations over **HAProxy → proxy → HAProxy** as a PoC (and a topology that may last). A later transport (Rust client + QUIC + Rust agent querying PG on localhost) must preserve the same operations and the same “no per-query TLS” rule. It is not a different product.

Discarded: in-process `pg` patch, JS `query.tid`, app-facing gRPC, CALL-only, `$1`-is-tid as the tool contract.

## Goals / Non-Goals

**Goals:**

- Specify the tool by operations and wire contract, not by a consumer’s schema.
- PoC: vanilla PG client → HAP GW → proxy → HAP shard → PG, plus Lookup.
- Any SQL after a valid tid (SELECT / INSERT / CALL / ORM text).
- Pooled backends so HAP-to-HAP (and proxy-to-shard-HAP) does not handshake TLS per query.
- E2E proof: Lookup golden tids land on the documented `hostIndex`.

**Non-Goals:**

- Implementing the Rust/QUIC client-agent (document only).
- Teaching HAProxy to parse SQL or tid.
- Changing Lookup (binary-split, opaque tid, power-of-two `SHARD_COUNT`).
- Fan-out / merge, ORM adapters as a required ship item, LISTEN/NOTIFY.
- Making pubkey UUID v8 or `uuid_last_16_bits` the placement function. Lookup hashes the tid **string** (SHA-256 prefix). Apps that need a different digest change Lookup in a versioned epoch, not this proxy.

## Decisions

### D1 — Operations are the product; SQL dialect is not

The proxy does not require stored procedures. It does not parse application meaning out of SQL. Consumers MAY use CALL, raw SQL, or an ORM; they MUST supply tid under the wire rule. Helpers that emit `SET mtdd.tid` are DX, not routing.

### D2 — HAProxy–HAProxy is the PoC transport; QUIC is the intended prod transport

```text
PoC / current:
  [PG client] → HAP GW (TCP VIP, pgsql-check)
             → mtdd-proxy (operations 1–5)
             → HAP shard[i] (TCP VIP, pgsql-check)
             → Postgres

Intended prod (later, same operations):
  [app + small Rust MTDD client]
             -- QUIC (long-lived session, multiplexed queries) --
  [Rust MTDD agent on DB host] → Postgres localhost
```

gRPC is not used on either path. HAP in prod may still front a VIP; it still does not parse SQL.

### D3 — Routing proxy, not a byte messenger

The proxy **terminates** client PG (startup + auth). It cannot splice one client TCP session to one shard for life: a pooled client issues many tids. It forwards **statement messages** to a **pooled** backend for `hostIndex` and relays results on the original socket.

HAProxy remains the dumb messenger. MTDD is the only hop that understands PG and tid.

### D4 — Tid on the wire is `SET mtdd.tid`

```sql
SET mtdd.tid = 'tenant-c';
SELECT 1;   -- or INSERT, CALL, ORM SQL
```

- Intercept `SET mtdd.tid` / `RESET mtdd.tid` (simple Query or equivalent). Do not require a real GUC on Postgres; the proxy consumes SET (MUST NOT fail because Postgres does not know `mtdd.tid` — either strip SET before forward, or SET a harmless placeholder).
- Tid applies to the **next statement** or until `COMMIT`/`ROLLBACK`/`RESET` (see D6). Not sticky for the life of a pooled client connection.
- Opaque string: no UUID parse required. Lookup gets the exact bytes.
- Reject data statements with no tid. Reject empty/NULL tid. Do not Lookup.

`$1` as tid is **not** the tool contract (hostile to ORM and ordinary SQL). Apps MAY still put a UUID in `$1` as data.

### D5 — Placement is Lookup binary-split

Proxy config: `MTDD_LOOKUP_URL`, `MTDD_SHARD_HOSTS` (length = Lookup `SHARD_COUNT`). `hostIndex` in `[0, N)`. Two Lookup golden vectors for N=2 (frozen in `mtdd_lookup`):

| tid | hostIndex |
|-----|-----------|
| `tenant-c` | `0` |
| `tenant-a` | `1` |

E2E MUST use these (or Lookup’s published table), not an app-specific email hash.

### D6 — Transactions pin a shard

After a statement with a tid, pin that client session to `hostIndex` until `COMMIT`/`ROLLBACK`. `BEGIN` with no tid yet is an error (or allowed only if the next statement in the tx supplies tid before any data — pick one in impl; prefer: first statement in tx must include tid). A later tid that maps to another shard while in a tx is an error.

### D7 — Backend pool: no per-query TLS

For each shard HAP VIP the proxy keeps a pool of already-authenticated PG connections (TLS to HAP, if enabled, happens at pool-connect). Execute uses an idle connection from that pool. HAP session counters / proxy metrics MUST show queries ≫ new backend connects under load.

PoC may run HAP as plain TCP; the same pool rule still applies (no per-query TCP+startup to shard HAP). When TLS is turned on between HAPs or proxy→HAP, reuse those TLS sessions.

QUIC later: one (or few) long-lived QUIC connections; queries are streams, not new TLS sessions. Same requirement, different transport.

### D8 — Auth v1

Shared `DB_USER`/`DB_PASSWORD` for client-facing and shard-facing PG. `database` MAY be rewritten per shard via config. Per-tenant users and password pass-through are later.

### D9 — Register and gRPC

`./register` / `install()` throw with migration text or the export is removed. App-facing `QueryStream` unused. Notify/gRPC is not kept “just in case.”

## Risks / Trade-offs

- [SET discipline] → forget SET → error (fail closed). Ship a tiny helper later; do not revive JS `tid`.
- [Postgres GUC] → `SET mtdd.tid` is not a stock GUC; proxy must intercept/strip.
- [Parser] → v1 recognizes SET/RESET + treats the rest as opaque SQL to forward; not a general SQL analyzer.
- [NOTIFY] → not on this path until a follow-up (native LISTEN on the backend, or QUIC).
- [Latency] → extra hops in PoC; mitigate with pools (D7). QUIC+localhost PG is the prod latency story.
- [Lookup vs SQL uuid bits] → Lookup uses SHA-256 prefix of the **tid string**, not `uuid_last_16_bits`. Do not special-case pubkey.

## Migration Plan

1. Lab: Lookup + HAP GW + proxy + two shard HAP + two PG. Golden `tenant-c` / `tenant-a` through the VIP.
2. Proxy v1: SET tid, Lookup, pooled execute, native result. Reject missing tid.
3. Fail-closed register; README: VIP + SET; no `--require`.
4. Optional app helper that emits SET (any app, not pubkey-only).
5. Keep HAP-HAP until Rust/QUIC is ready; then swap **transport** only.

## Open Questions

- Exact SET scoping: next statement vs until COMMIT when not in a tx (recommend: next statement in autocommit; pin until COMMIT in a tx).
- Whether PoC enables TLS on HAP backends in lab or only proves TCP pool reuse (recommend: prove pool reuse first; TLS on the same pools when ops wants it).

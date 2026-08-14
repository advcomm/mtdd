## Why

MTDD is a **routing tool**, not an application framework and not a stored-procedure gate. Its job is: take a tenant id and a statement, run that statement on exactly one shard, return the database’s native result.

Today that job is done by patching `pg` in-process (`@advcomm/mtdd/register`) and shipping work over gRPC. That couples every app to `--require`, hides `tid` as a JavaScript field that never appears on the Postgres wire, and makes gRPC the app-facing transport. A HAProxy lab showed vanilla `pg` already carries SQL and bind params through a TCP VIP; HAProxy does not parse them. Placement already lives in `@advcomm/mtdd_lookup` as **binary split** on an opaque `tid`. The missing piece is a process that reads `tid` from the wire, calls Lookup, and executes on one shard — without dictating CALL vs ORM vs raw SQL.

Production inclination (not this PoC): a small Rust MTDD client talking QUIC to a Rust agent beside Postgres (`localhost`). That multiplexes work on long-lived sessions so a new TLS handshake is not created per query. This change PoCs the same **operations** over HAProxy → proxy → HAProxy and may stay that way for some time. gRPC is not required on either path.

## What Changes

- Define MTDD by **operations** (see design): bind tid → lookup → execute on one shard → native result. Apps choose SQL shape; Lookup chooses `hostIndex`; HAProxy stays a dumb TCP VIP.
- **BREAKING**: Remove `@advcomm/mtdd/register` as the supported production entry. Apps use vanilla `pg` (or any PG client) pointed at one HAProxy GW VIP.
- **Wire tid:** `SET mtdd.tid = '<opaque-string>'` then the statement. Not `query.tid`, not “first bind param”, not “must be CALL”. Missing/empty tid is an error.
- Run MTDD as an out-of-process **routing proxy** between two HAProxies: terminate client PG, Lookup, forward the same statement to that shard’s HAP, relay native PG on the same client socket.
- **Reuse backend sessions.** The proxy MUST hold a pool per shard (to shard HAP). A new TLS (or TCP/PG startup) session MUST NOT be created for every query on the HAP-GW ↔ HAP-shard path.
- **BREAKING**: Drop app-facing gRPC `QueryStream`. Drop `tid: null` fan-out / SELECT merge. Transport after this PoC is QUIC (Rust), not gRPC.
- Keep HTTP Lookup (`POST /lookup` `{ tid }` → `{ hostIndex }`) as implemented: opaque tid, binary-split, `SHARD_COUNT = 2^k`. Do not reimplement placement in the proxy or in apps.

## Capabilities

### New Capabilities

- `pg-wire-proxy`: Out-of-process PG routing proxy behind HAProxy; vanilla clients; native results; pooled backends (no per-query TLS); HAP-HAP is the PoC transport.
- `sp-first-param-tid`: **Retitled in the spec body to “tid on the wire”.** Placement from `SET mtdd.tid`; any following SQL; Lookup binary-split; one shard; reject missing tid. Directory name kept for this change.

### Modified Capabilities

- (none — no existing `openspec/specs/` capabilities in this repo)

## Impact

- `@advcomm/mtdd`: `register` / in-process executor become fail-closed or deleted; new proxy process; README / `.env.example`; no JSON-array `DB_HOST` on the app.
- Lookup (`mtdd_lookup`): unchanged algorithm. Proxy is a Lookup client. Apps do not call Lookup.
- Apps (any): `DB_HOST`/`DB_PORT` = GW VIP; emit `SET mtdd.tid` (helper/adapter later). Pubkey UUID v8 is **one consumer’s tid format**, not the tool contract.
- Infra PoC: HAP GW → proxy → HAP shard[i] → PG; Lookup beside the proxy.
- Infra later: Rust client ↔ QUIC ↔ Rust agent → PG localhost; HAP optional for VIP only.
- `mtdd_server` gRPC: not on the product path.

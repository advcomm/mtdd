# LISTEN / NOTIFY — delta implementation spec

Extend **existing** `@advcomm/mtdd` (`--require @advcomm/mtdd/register`). Do **not** rebuild the package.

## Preserve

- gRPC shard routing via `grpc-hub.js` and `QueryStream` for ordinary SQL
- AST classification via `sql-parse.js` for everything except LISTEN/UNLISTEN/NOTIFY pre-parse
- Lookup, fan-out, aggregate local merge, transactions on pinned checkout clients

## Add

1. **Detect** `LISTEN`, `UNLISTEN`, `UNLISTEN *`, `NOTIFY` in `listen-notify-parse.js` / `sql-parse.js` → `commandType` on `req`
2. **Route early** in `executeRoutedQuery` **before** `fanOutQuery`, `queryShard`, or `assertTransactionRouting` fan-out errors
3. **Never** send LISTEN/UNLISTEN/NOTIFY as `QueryStream` shard SQL
4. **`notification-registry.js`** — `WeakMap` facade client ↔ logical id; `EventEmitter` for `notification` events
5. **`mtdd-notify-transport.js`** + **`grpc-notify-client.js`** — `MtddNotify` gRPC (`Subscribe`, `Unsubscribe`, `UnsubscribeAll`, `Publish`, `Watch`); in-memory when `MTDD_GRPC_MOCK=1` / `MTDD_NOTIFY_MOCK=1`
6. **`listen-notify-handler.js`** — registry + transport; return synthetic pg results
7. **Tests** — detect, transport calls, registry, `client.emit('notification')`
8. **README** — coordinator/transport requirements for production

## Semantics (v1)

| Topic | Decision |
|-------|----------|
| NOTIFY delivery | Single `publish` to notify transport (coordinator-style); not per-shard `QueryStream` |
| `tid` | Optional; scopes channel key when set (`tid:channel`), else global namespace |
| Production transport | `MtddNotify` on `MTDD_NOTIFY_URL` or first `DB_HOST` + `MTDD_GRPC_PORT` (aligned with mtdd_server) |
| `processId` in events | `0` (synthetic) until server provides real pid |
| Transactions | `BEGIN`/`COMMIT`/`ROLLBACK` unchanged; LISTEN allowed on pinned checkout without `tid` |

## Do not

- Re-create package layout, `host-selector` round-robin, or regex-only classifier for all SQL
- Bypass gRPC for normal queries
- Implement Parse/Bind/Execute

## Touch points

- `query-executor.js` — early branch
- `sql-parse.js` / `query-classifier.js` — command types + helpers
- `patch.js` — init notify transport at preload
- `index.js` — export registry/transport for tests

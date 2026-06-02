# @advcomm/mtdd

**MTDD** = Multi-Tenant Database Driver.

Production-only PostgreSQL interception and routing layer for Node.js applications using the standard [`pg`](https://node-postgres.com/) driver.

`@advcomm/mtdd` transparently patches `pg`, validates production `DB_HOST` arrays, resolves shard targets through an HTTP **Lookup server** when `tid` is present, fans out to all shards when `tid` is absent, and propagates tenant context — without changing application code between development and production.

## Quick start

### Development

```env
DB_HOST=localhost
```

```bash
node app.js
```

Vanilla `pg` connects to `localhost`. Do **not** preload MTDD in development.

### Production

```env
DB_HOST=["10.0.1.10","10.0.1.11","10.0.1.12"]
DB_NAME=myapp
DB_USER=app
DB_PASSWORD=secret
DB_PORT=5432
MTDD_LOOKUP_URL=http://lookup:8080/lookup
MTDD_GRPC_PORT=50051
MTDD_REDIS_URL=redis://redis:6379
MTDD_SQL_CLASSIFY_CACHE_TTL_MS=3600000
```

```bash
node --require @advcomm/mtdd/register app.js
```

Or:

```bash
NODE_OPTIONS="--require @advcomm/mtdd/register" node app.js
```

Application code stays the same; only the process preload, `DB_HOST` format, and lookup URL change.

## Developing this package

Source is **TypeScript** under [`src/`](src/). The npm package ships compiled JavaScript in `dist/`.

```bash
npm ci
npm run build    # tsc → dist/
npm test         # build + node --test on dist/test/
```

TypeScript migration checks (in `test/`): compiled `dist/` layout, `package.json` exports, proto path from `dist/src`, and a strict `tsc` consumer fixture under `test/fixtures/`.

Preload and imports for apps are unchanged: `@advcomm/mtdd/register` resolves to the built `register.js`.

## Application code (unchanged)

```js
const { Pool } = require('pg')

function parseDbHost(value) {
  if (!value) return 'localhost'
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) return JSON.parse(trimmed)
  return trimmed
}

const pool = new Pool({
  host: parseDbHost(process.env.DB_HOST),
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
})
```

| Environment | `DB_HOST` | Without MTDD | With MTDD |
|-------------|-----------|--------------|-----------|
| Development | `localhost` | Works | N/A (no preload) |
| Production | `["10.0.1.10",…]` | **Fails** (pg rejects arrays) | Facade + per-query routing |

## Query routing

| `tid` on query | Behavior |
|----------------|----------|
| **Present** | `POST` to Lookup server → `hostIndex` → `Query` over gRPC to that shard |
| **Absent** | `Query` on **every** shard via gRPC in parallel → **command-aware merge** (see below) |

**INSERT** always requires `tid` (even on a single-host pool). Lookup resolves to exactly one `host_index`; the query runs on that shard only and the result is returned unchanged (including `RETURNING`). INSERT never fans out.

**CALL** (stored procedures) requires `tid` to be set: a **tenant id string** routes via lookup to one `host_index` and returns that shard’s result unchanged; **`tid: null`** runs the procedure on **every** shard and returns an empty `CALL` result (`rowCount: 0`, no rows). Omitting `tid` is an error.

**Stored functions** (`SELECT … FROM fn(…)` or `SELECT fn(…)`) always require a **tenant id string** `tid`. Lookup resolves to one `host_index`; the shard `SELECT` result is returned unchanged. They never fan out.

**SELECT** (table queries, not stored functions): with a **tenant id string** `tid`, lookup resolves to one `host_index` and the shard result is returned unchanged. Without `tid`, `SELECT` fans out to every shard and rows are merged (concat `rows`, sum `rowCount`).

**SELECT with `ORDER BY` or supported aggregates** (no `tid`): shards return row-level columns; rows are loaded into a **localhost temp table** and the original SQL is re-run for global `ORDER BY`, `GROUP BY`, and aggregates. Supported built-ins include `sum`, `min`, `max`, `count`, `avg`, `bool_and` / `bool_or`, statistical (`stddev`, `var`, `corr`, `regr_*`, …), and `range_*` aggregates. **Rejected** for fan-out: window functions (`OVER`), `any_value`, hypothetical-set aggregates (`rank`, `dense_rank`, `percent_rank`, `cume_dist`), order-sensitive aggregates (`string_agg`, `json_*`, `array_agg`, `xmlagg`, …) without `ORDER BY` inside the aggregate, user-defined aggregates, and subqueries inside aggregate arguments.

### gRPC shard tunnels (startup)

On preload, MTDD verifies **PostgreSQL on `localhost`** using `DB_NAME`, `DB_USER`, `DB_PASSWORD`, and `DB_PORT` from the environment (`DB_HOST` is ignored for this probe). Startup fails if `SELECT 1` cannot be completed. Set `MTDD_SKIP_LOCAL_PG_CHECK=1` or `MTDD_GRPC_MOCK=1` to skip (tests use the latter). Optional `MTDD_LOCAL_PG_CONNECT_TIMEOUT_MS` (default `5000`).

MTDD then opens a **persistent gRPC client** to each IP in `DB_HOST` (port `MTDD_GRPC_PORT`, default `50051`). For each address it calls `Connect` with:

| Field | Source |
|-------|--------|
| `host_index` | Position in `DB_HOST` (0-based) |
| `database` | `DB_NAME` |
| `user` | `DB_USER` |
| `password` | `DB_PASSWORD` |
| `port` | `DB_PORT` (PostgreSQL port the shard server uses) |

**All** shards must accept `Connect` successfully or the process **exits on startup** with an error. Queries are sent with `Query` on the same tunnel; results return over gRPC (not direct `pg` TCP to each host).

#### Preload logging (`register.js`)

Startup steps are logged by [`preload-logger.js`](preload-logger.js) using `NODE_ENV` (and `MTDD_GRPC_MOCK` when `NODE_ENV` is unset):

| `NODE_ENV` | Default level | Output |
|------------|---------------|--------|
| `development` / `dev` | `debug` | Human-readable steps, per-step timings, full shard list |
| `test` | `warn` | Failures and warnings only (quiet test runs) |
| `staging` | `info` | JSON lines with shard endpoints and timings |
| `production` / `prod` | `info` | JSON lines; lookup URL redacted |

| Variable | Purpose |
|----------|---------|
| `MTDD_PRELOAD_LOG_LEVEL` | Override level: `debug`, `info`, `warn`, `error` |
| `MTDD_LOG_BACKEND` | `console` (default) or `otel` |
| `MTDD_LOG_OTEL=1` | Shorthand for `MTDD_LOG_BACKEND=otel` in **production only** |

**OpenTelemetry in production:** set `NODE_ENV=production` and `MTDD_LOG_BACKEND=otel` (or `MTDD_LOG_OTEL=1`). Install `@opentelemetry/api` and register your SDK in the app **before** `--require @advcomm/mtdd/register` so preload spans and events export to your collector. If the API package is missing, MTDD falls back to structured console JSON for errors and warnings.

Example production:

```bash
NODE_ENV=production MTDD_LOG_BACKEND=otel node --require @advcomm/mtdd/register app.js
```

Proto definition: [`proto/mtdd.proto`](proto/mtdd.proto).

#### gRPC wire format (libpq + Arrow streaming)

| Piece | Format |
|-------|--------|
| **Connect** | libpq keywords in `ConnectRequest` (`dbname`, `user`, `password`, `port`, `host`, …) |
| **Query** | `QueryStream` with `PQexecParams`-style `params[]` (`oid`, `format` 0=text/1=binary, `value` bytes) |
| **Result metadata** | FlexBuffers in `ResultChunk.flatbuffer_meta` ([`flatbuffers/result-meta-codec.js`](flatbuffers/result-meta-codec.js)) |
| **Result rows** | Apache Arrow IPC in `ResultChunk.arrow_ipc` |

Shard agents must implement **`QueryStream` only** (unary `Query` + JSON `result_json` was removed). The client requires [`apache-arrow`](https://www.npmjs.com/package/apache-arrow) and [`flatbuffers`](https://www.npmjs.com/package/flatbuffers).

Chunk sequence: `SCHEMA` → `BATCH`* → `TRAILER` (or `ERROR`). The Node client decodes Arrow batches into the same pg `Result` shape (`rows`, `fields`, `rowCount`) used by merge logic.

**Breaking change:** upgrade shard servers before deploying a client build that uses this proto.

**Plain SQL only:** Do not set `name` on query configs (`mtdd_server` rejects `QueryRequest.name`). ORMs are not supported.

**Not in v1:** Parse/Bind/Execute RPCs on the wire.

`tid` resolution order:

```js
const tid = queryConfigTid ?? asyncContext?.tid ?? undefined
```

Missing `tid` is valid (e.g. global reference data). Override merge / coordinator logic in `onQuery` (see below).

SQL routing uses **AST classification** ([`pgsql-ast-parser`](https://www.npmjs.com/package/pgsql-ast-parser)) in [`sql-parse.js`](sql-parse.js). There is no regex fallback. Unparseable SQL or multi-statement strings throw `MtddSqlParseError`. `CALL` is detected via a dedicated pre-parse check because that parser does not support the `CALL` statement type.

Classification results (`commandType`, `hasReturning`) are cached in-process and optionally in **Redis** ([`ast-classify-cache.js`](ast-classify-cache.js)):

| Setting | Default | Purpose |
|---------|---------|---------|
| `MTDD_REDIS_URL` | *(unset)* | When set, share classification cache across processes |
| `MTDD_SQL_CLASSIFY_CACHE_TTL_MS` | `3600000` (60 min) | Sliding TTL — reset on each cache hit; entry expires after this long with no use |

Redis keys: `mtdd:sql:classify:` + SHA-256(hex) of the exact query text. Values are JSON classification objects.

### Fan-out merge by SQL type

When a query fans out (no `tid`), MTDD classifies `req.text` and merges shard results in core before returning to the app.

**DELETE** and **UPDATE**:

| Case | `command` | `rowCount` | `rows` |
|------|-----------|------------|--------|
| DML without `RETURNING` | `DELETE` / `UPDATE` | Sum across shards | `[]` (always empty, like single-shard `pg`) |
| DML with `RETURNING` | `DELETE` / `UPDATE` | Sum across shards | Concatenate shard rows in host-index order (0 → N−1) |

`SELECT` without `tid` uses the generic merge (concat `rows`, sum `rowCount`). `SELECT` with `tid` is not merged (single shard). `hooks.onQuery` can wrap `next()` to override any merge.

Helpers: `classifyQuery`, `mergeFanOutResults`, `mergeDeleteResults`, `mergeUpdateResults`, `mergeDmlResults` (package root exports).

### Lookup server (HTTP JSON)

Required when MTDD is loaded:

```env
MTDD_LOOKUP_URL=http://lookup:8080/lookup
MTDD_LOOKUP_TIMEOUT_MS=2000
```

**Request**

```http
POST /lookup
Content-Type: application/json

{"tid":"tenant-abc"}
```

**Response**

```json
{"hostIndex":1}
```

- `hostIndex` is 0-based and must satisfy `0 <= hostIndex < DB_HOST.length`.
- The lookup service may be **stateful or stateless**; MTDD sends a stateless HTTP POST per query that includes `tid`.
- Override transport via `hooks.onLookup(req, next)` (`next()` calls the default HTTP client).

### Transactions

- With `tid`, `pool.connect()` clients are **pinned** to the shard from the first routed query (required for `BEGIN` / `COMMIT`).
- **Fan-out is not supported** on checked-out clients or `BEGIN` without `tid` on multi-host pools.
- `LISTEN` / `UNLISTEN` / `NOTIFY` are handled separately (see below) and do not require `tid` on a checked-out client.

### LISTEN / NOTIFY

`LISTEN`, `UNLISTEN`, `UNLISTEN *`, and `NOTIFY` are **not** sent as shard `QueryStream` SQL. They are handled client-side:

- **Registry** — logical subscription per pool/client/checkout facade (`notification-registry.js`)
- **Transport** — `MtddNotify` gRPC on a coordinator (`Subscribe`, `Unsubscribe`, `UnsubscribeAll`, `Publish`, `Watch`). In-memory when `MTDD_GRPC_MOCK=1` or `MTDD_NOTIFY_MOCK=1`. Production: **`MTDD_NOTIFY_URL`** for multi-shard (required); single-shard may omit it (defaults to first `DB_HOST` write IP + `MTDD_GRPC_PORT`). Align [proto/mtdd.proto](proto/mtdd.proto) with [mtdd_server](https://github.com/advcomm/mtdd_server) — notify subscriptions are in-memory per server process.
- **Limits** — `MTDD_MAX_NOTIFY_CHANNEL_BYTES` (default `63`) and `MTDD_MAX_NOTIFY_PAYLOAD_BYTES` (default `65535`), matching server validation.
- **Events** — checked-out clients expose `pg`-compatible `notification` events (`channel`, `payload`, `processId`)
- **Results** — synthetic empty results with `command` set to `LISTEN`, `UNLISTEN`, or `NOTIFY`

Optional `tid` on the query scopes the channel namespace (`tid:channel`). Without `tid`, channels use a global namespace.

```js
const client = await pool.connect()
client.on('notification', (msg) => {
  console.log(msg.channel, msg.payload)
})
await client.query('LISTEN orders')
await pool.query("NOTIFY orders, 'ready'")
```

Multi-shard production example:

```env
DB_HOST=["10.0.1.10","10.0.1.11"]
MTDD_NOTIFY_URL=10.0.0.100:50051
```

Run `MtddNotify` on that coordinator host (`MTDD_NOTIFY_ENABLED=1` on [mtdd_server](https://github.com/advcomm/mtdd_server)); set `MTDD_NOTIFY_ENABLED=0` on shard-only nodes.

See `examples/listen-notify-example.js` and `docs/LISTEN-NOTIFY.md` for the implementation spec.

### Shutdown and TLS

Call `shutdownMtdd()` before `pool.end()`, or set `MTDD_AUTO_SHUTDOWN=1`. For production TLS, terminate at nginx and set `MTDD_GRPC_TLS=1` + `MTDD_GRPC_TLS_CA_FILE` on the client (verifies nginx, not `mtdd_server`). Optional `MTDD_GRPC_UNIX_SOCKET` for single-shard local dev without nginx — see [docs/OPERATIONS.md](docs/OPERATIONS.md) and [mtdd_server@c4a05f6](https://github.com/advcomm/mtdd_server/commit/c4a05f63294c2251e2bb19ec5de92ceba70cf8de).

| Variable | Purpose |
|----------|---------|
| `MTDD_FANOUT_POLICY` | `all` (default) or `best_effort` |
| `MTDD_LOOKUP_CACHE_TTL_MS` | Cache `tid` → `hostIndex` (default `30000`, `0` disables) |
| `MTDD_GRPC_MAX_RETRIES` / `MTDD_LOOKUP_RETRY_COUNT` | Transient retry attempts |
| `MTDD_GRPC_QUERY_TIMEOUT_MS` | Per-query gRPC deadline |

## Tenant context

### Per-query `tid`

```js
await pool.query({
  text: 'SELECT * FROM users',
  values: [],
  tid: req.tid,
})
```

`tid` is used for lookup and `onQuery`; it is **not** sent to PostgreSQL.

### AsyncLocalStorage

```js
const { runWithMtddContext } = require('@advcomm/mtdd/context')

app.use((req, res, next) => {
  runWithMtddContext(
    { tid: req.tid, userId: req.user?.id, requestId: req.id },
    next,
  )
})
```

```js
await pool.query('SELECT * FROM users') // tid from context → lookup routing
```

## Hooks

```js
const hooks = require('@advcomm/mtdd/hooks')

hooks.onQuery       // merge / coordinator logic (fan-out default inside next())
hooks.onLookup      // optional HTTP lookup override
hooks.onSelectHost  // after lookup (strategy: 'lookup')
hooks.onConnect     // pass-through
```

### Custom fan-out merge

```js
const hooks = require('@advcomm/mtdd/hooks')
const { fanOutOnly } = require('@advcomm/mtdd')

hooks.onQuery = async (req, next) => {
  if (req.tid) return next()

  const shardResults = await fanOutOnly(req.pool, req)
  // Custom joins, aggregates, or a second query on localhost:
  // return runCoordinatorQuery(shardResults)
  return customMerge(shardResults)
}
```

Helpers exported from the package root: `fanOutOnly`, `defaultMergeResults`.

## Production `DB_HOST` rules

When `@advcomm/mtdd/register` loads, `process.env.DB_HOST` is validated **before** any PostgreSQL connection:

1. Must be set.
2. Must be valid JSON.
3. Must parse to a **non-empty array**.
4. Every element must be an IPv4 or IPv6 address (`node:net.isIP`).
5. Hostnames and single-string values are rejected.

## Package layout

| Source (`src/`) | Role |
|-----------------|------|
| `register.ts` | Preload entry (`--require`) |
| `patch.ts` | `pg` monkey-patch |
| `pool-facade.ts` | Multi-host pool facade + lazy sub-pools |
| `lookup-client.ts` | HTTP lookup client |
| `query-executor.ts` | Per-query shard routing |
| `listen-notify-parse.ts` | Pre-parse `LISTEN` / `UNLISTEN` / `NOTIFY` |
| `listen-notify-handler.ts` | Client-side LISTEN/NOTIFY execution |
| `notification-registry.ts` | Facade client ↔ subscription registry + `notification` events |
| `mtdd-notify-transport.ts` | Notify transport (memory mock / `MtddNotify` gRPC) |
| `grpc-notify-client.ts` | gRPC client for `MtddNotify` |
| `notify-policy.ts` | `MTDD_NOTIFY_URL` resolution |
| `synthetic-results.ts` | Synthetic pg results for LISTEN/UNLISTEN/NOTIFY |
| `sql-parse.ts` | AST parse + classify (`pgsql-ast-parser`); `MtddSqlParseError` on failure |
| `ast-classify-cache.ts` | In-memory + optional Redis cache for classification (SHA-256 keys) |
| `query-classifier.ts` | Thin wrapper: `attachQueryClassification`, `isInsertQuery`, … |
| `merge-results.ts` | Fan-out merge (`mergeFanOutResults`, `mergeDeleteResults`) |
| `host-policy.ts` | `DB_HOST` validation |
| `grpc-hub.ts` | gRPC connect-all + `Query` routing |
| `grpc-credentials.ts` | `DB_NAME` / `DB_USER` / `DB_PASSWORD` for `Connect` |
| `lookup-policy.ts` | `MTDD_LOOKUP_URL` validation |
| `postgres-local.ts` | Startup `localhost` PostgreSQL connectivity check |
| `normalize.ts` | Query argument normalization |
| `context.ts` | `AsyncLocalStorage` helpers |
| `hooks.ts` | Hook entry points |

## Examples

See [`examples/`](examples/):

- `app-dev.ts` — development without preload
- `app-prod.ts` — production with host array
- `express-context-example.js` — `runWithMtddContext`
- `lookup-mock-server.js` — minimal lookup HTTP server
- `custom-onquery-merge.js` — custom fan-out merge via `onQuery`

## Tests

```bash
npm test
```

## License

MIT

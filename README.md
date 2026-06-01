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
```

```bash
node --require @advcomm/mtdd/register app.js
```

Or:

```bash
NODE_OPTIONS="--require @advcomm/mtdd/register" node app.js
```

Application code stays the same; only the process preload, `DB_HOST` format, and lookup URL change.

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

### gRPC shard tunnels (startup)

On preload, MTDD opens a **persistent gRPC client** to each IP in `DB_HOST` (port `MTDD_GRPC_PORT`, default `50051`). For each address it calls `Connect` with:

| Field | Source |
|-------|--------|
| `host_index` | Position in `DB_HOST` (0-based) |
| `database` | `DB_NAME` |
| `user` | `DB_USER` |
| `password` | `DB_PASSWORD` |
| `port` | `DB_PORT` (PostgreSQL port the shard server uses) |

**All** shards must accept `Connect` successfully or the process **exits on startup** with an error. Queries are sent with `Query` on the same tunnel; results return over gRPC (not direct `pg` TCP to each host).

Proto definition: [`proto/mtdd.proto`](proto/mtdd.proto).

`tid` resolution order:

```js
const tid = queryConfigTid ?? asyncContext?.tid ?? undefined
```

Missing `tid` is valid (e.g. global reference data). Override merge / coordinator logic in `onQuery` (see below).

### Fan-out merge by SQL type

When a query fans out (no `tid`), MTDD classifies `req.text` and merges shard results in core before returning to the app.

**DELETE** (phase 1):

| Case | `command` | `rowCount` | `rows` |
|------|-----------|------------|--------|
| `DELETE` without `RETURNING` | `DELETE` | Sum across shards | `[]` (always empty, like single-shard `pg`) |
| `DELETE ... RETURNING ...` | `DELETE` | Sum across shards | Concatenate shard rows in host-index order (0 → N−1) |

Other statement types still use the generic merge (concat `rows`, sum `rowCount`) until INSERT, UPDATE, and SELECT handlers are added. `hooks.onQuery` can wrap `next()` to override any merge.

Helpers: `classifyQuery`, `mergeFanOutResults`, `mergeDeleteResults` (package root exports).

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

| File | Role |
|------|------|
| `register.js` | Preload entry (`--require`) |
| `patch.js` | `pg` monkey-patch |
| `pool-facade.js` | Multi-host pool facade + lazy sub-pools |
| `lookup-client.js` | HTTP lookup client |
| `query-executor.js` | Per-query shard routing |
| `query-classifier.js` | SQL command detection (DELETE, RETURNING, …) |
| `merge-results.js` | Fan-out merge (`mergeFanOutResults`, `mergeDeleteResults`) |
| `host-policy.js` | `DB_HOST` validation |
| `grpc-hub.js` | gRPC connect-all + `Query` routing |
| `grpc-credentials.js` | `DB_NAME` / `DB_USER` / `DB_PASSWORD` for `Connect` |
| `lookup-policy.js` | `MTDD_LOOKUP_URL` validation |
| `normalize.js` | Query argument normalization |
| `context.js` | `AsyncLocalStorage` helpers |
| `hooks.js` | Hook entry points |

## Examples

See [`examples/`](examples/):

- `app-dev.js` — development without preload
- `app-prod.js` — production with host array
- `express-context-example.js` — `runWithMtddContext`
- `lookup-mock-server.js` — minimal lookup HTTP server
- `custom-onquery-merge.js` — custom fan-out merge via `onQuery`

## Tests

```bash
npm test
```

## License

MIT

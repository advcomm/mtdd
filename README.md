# @advcomm/mtdd

**MTDD** = Multi-Tenant Database Driver.

Production-only PostgreSQL interception and routing layer for Node.js applications using the standard [`pg`](https://node-postgres.com/) driver.

`@advcomm/mtdd` transparently patches `pg`, validates production `DB_HOST` arrays, selects one database host per `Pool`/`Client`, propagates tenant context, and intercepts queries — without changing application code between development and production.

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
```

```bash
node --require @advcomm/mtdd/register app.js
```

Or:

```bash
NODE_OPTIONS="--require @advcomm/mtdd/register" node app.js
```

Application code stays the same; only the process preload and `DB_HOST` format change.

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

| Environment | `DB_HOST` | `host` passed to `Pool` | Without MTDD | With MTDD |
|-------------|-----------|-------------------------|--------------|-----------|
| Development | `localhost` | `'localhost'` | Works | N/A (no preload) |
| Production | `["10.0.1.10",…]` | `['10.0.1.10',…]` | **Fails** (pg rejects arrays) | Validates, picks one IP, connects |

## Production `DB_HOST` rules

When `@advcomm/mtdd/register` loads, `process.env.DB_HOST` is validated **before** any PostgreSQL connection:

1. Must be set.
2. Must be valid JSON.
3. Must parse to a **non-empty array**.
4. Every element must be an IPv4 or IPv6 address (`node:net.isIP`).
5. Hostnames and single-string values are rejected.

Valid:

```env
DB_HOST=["10.0.1.10"]
DB_HOST=["10.0.1.10","10.0.1.11"]
DB_HOST=["2001:db8::1"]
```

Invalid:

```env
DB_HOST=localhost
DB_HOST=postgres.example.com
DB_HOST=10.0.1.10
DB_HOST=["postgres.example.com"]
DB_HOST=[]
```

## Host selection

For `new Pool({ host: ['10.0.1.10', '10.0.1.11'] })`, MTDD:

1. Runs round-robin selection (`selectHost`).
2. Invokes the `onSelectHost` hook (pass-through by default).
3. Replaces the array with one IP before calling real `pg`.
4. Invokes the `onConnect` hook (pass-through by default).

One `Pool` / `Client` instance → one selected host. MTDD does **not** connect to every host.

## Tenant context

### Per-query `tid`

```js
await pool.query({
  text: 'SELECT * FROM users',
  values: [],
  tid: req.tid,
})
```

`tid` is forwarded to `onQuery` and is **not** sent to PostgreSQL.

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
await pool.query('SELECT * FROM users') // tid from context when omitted
```

Resolution order:

```js
const tid = queryConfigTid ?? asyncContext?.tid ?? undefined
```

Missing `tid` is valid (e.g. `SELECT * FROM countries`).

## Hooks

```js
const hooks = require('@advcomm/mtdd/hooks')

// async (request, next) => next()
hooks.onQuery
hooks.onConnect
hooks.onSelectHost
```

Default implementations are pass-through. Replace or wrap them for custom telemetry or policy.

## What MTDD does **not** do (v1)

- SQL rewriting
- Tenant-based routing to different databases
- Health checks or replica awareness
- Connect-to-all-hosts

## Package layout

| File | Role |
|------|------|
| `register.js` | Preload entry (`--require`) |
| `patch.js` | `pg` monkey-patch |
| `host-policy.js` | `DB_HOST` validation |
| `host-selector.js` | Round-robin host selection |
| `normalize.js` | Query argument normalization |
| `context.js` | `AsyncLocalStorage` helpers |
| `hooks.js` | `onQuery`, `onConnect`, `onSelectHost` |

## Examples

See [`examples/`](examples/):

- `app-dev.js` — development without preload
- `app-prod.js` — production with host array
- `express-context-example.js` — `runWithMtddContext`

## Tests

```bash
npm test
```

## License

MIT

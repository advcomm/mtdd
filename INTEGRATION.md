# MTDD integration guide

This is the contract for **consuming apps**. MTDD is a routing tool: you name a tenant (`tid`) on the Postgres wire; the platform runs your SQL on exactly one shard and returns a native result.

You do **not** install a `pg` preload, call Lookup from business code, or compute shard indexes.

Lab topology and proxy env: [`scripts/haproxy/README.md`](scripts/haproxy/README.md). Product overview: [`README.md`](README.md).

---

## What the app owns

| You do | You do not |
|--------|------------|
| Choose what `tid` *means* (tenant id, email UUID, …) and normalize it | Hash `tid` for placement / compute `hostIndex` |
| Point a stock Postgres client at **one** gateway VIP | Put a JSON array in `DB_HOST` |
| `SET mtdd.tid` on the **same connection** as the SQL | `--require @advcomm/mtdd/register` |
| Pass a tid on every statement (including health and jobs) | Omit SET and hope for fan-out (`tid: null` is gone) |

Placement lives in Lookup (`mtdd_lookup`). The proxy calls it. Your schema and SQL stay yours (SELECT, INSERT, CALL, ORM — any SQL).

---

## Topology (PoC)

```text
your app (vanilla pg / any PG client)
    → HAProxy gateway   127.0.0.1:15432
    → mtdd-proxy        127.0.0.1:6432
    → HAProxy shard     127.0.0.1:15442 | 15443
    → Postgres
```

App env — **single host**, not a shard list:

```env
DB_HOST=127.0.0.1
DB_PORT=15432
DB_USER=postgres
DB_PASSWORD=...
DB_NAME=anything          # startup packet only; routing uses proxy shard DBs
```

Do not set `DB_HOST=["10.0.1.10","10.0.1.11"]`. Shard hosts are **proxy** config (`MTDD_SHARD_HOSTS`), aligned with Lookup `SHARD_COUNT`.

Without HAProxy you can point the app at the proxy port (`6432`) instead of `15432`. The SET contract is the same.

---

## Wire contract

On **one** Postgres session:

```sql
SET mtdd.tid = '<opaque>';
-- next statement only (autocommit)
SELECT 1;
```

Rules:

1. **Same TCP connection.** `SET` then SQL must not bounce across a pool.
2. **Autocommit:** tid is consumed by the next statement. SET again before the next query.
3. **Transaction:** SET, then `BEGIN` … `COMMIT` / `ROLLBACK` on that connection. The shard is pinned until the transaction ends. `RESET mtdd.tid` is not allowed inside a transaction.
4. **Missing SET** → Postgres error (`mtdd.tid is not set`). No shard I/O, no silent fallback to localhost.
5. **Tid is opaque.** Send the bytes you mean. Lookup SHA-256s them as received. Goldens (`SHARD_COUNT=2`): `tenant-c` → shard 0, `tenant-a` → shard 1.

Quote the tid as a SQL string (double any `'`). Parameterized `SET mtdd.tid = $1` also works through the proxy.

---

## Footgun: `Pool.query` is two connections

This **drops the tid** with `pg.Pool` (and most pools):

```js
// WRONG — SET and SELECT can run on different checkouts
await pool.query("SET mtdd.tid = 'tenant-c'")
await pool.query('SELECT 1')
```

Checkout one client, SET, query, release. Helpers below do that.

---

## Node.js (`pg`) helpers

Copy these into the app. They are DX, not a driver patch, and are not published as `@advcomm/mtdd` exports.

### Quote + SET

```js
function sqlSetMtddTid(tid) {
  const value = String(tid ?? '').trim()
  if (!value) throw new Error('mtdd.tid must be a non-empty string')
  return `SET mtdd.tid = '${value.replace(/'/g, "''")}'`
}
```

### Autocommit query (required pattern)

```js
const { Pool } = require('pg')

const pool = new Pool({
  host: process.env.DB_HOST, // HAP GW VIP
  port: Number(process.env.DB_PORT || 15432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
})

async function queryWithTid(tid, text, values = []) {
  const client = await pool.connect()
  try {
    await client.query(sqlSetMtddTid(tid))
    return await client.query(text, values)
  } finally {
    client.release()
  }
}

const result = await queryWithTid('tenant-c', 'SELECT 1 AS n')
```

TypeScript:

```ts
import pg from 'pg'

export async function queryWithTid(
  pool: pg.Pool,
  tid: string,
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult> {
  const client = await pool.connect()
  try {
    await client.query(sqlSetMtddTid(tid))
    return await client.query(text, values)
  } finally {
    client.release()
  }
}
```

### Transaction (pin until COMMIT)

```js
async function withTidTx(tid, fn) {
  const client = await pool.connect()
  try {
    await client.query(sqlSetMtddTid(tid))
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw err
  } finally {
    client.release()
  }
}

await withTidTx('tenant-c', async (client) => {
  await client.query('INSERT INTO orders(id) VALUES ($1)', [1])
  return client.query('SELECT * FROM orders WHERE id = $1', [1])
})
```

Inside `fn`, do **not** SET a tid that maps to another shard.

### Stored procedures / CALL

Any SQL is fine. Keep SET on the same checkout:

```js
await queryWithTid(tid, 'CALL sp_ping($1)', [null])
await queryWithTid(tid, 'SELECT * FROM sp_algorithms_list()')
```

Do not invent a `$1 = tid` convention unless your own procedures already take that argument. MTDD does not read SQL parameters for routing.

---

## Other languages

Same rule: one session, SET, then SQL.

### Python (`psycopg`)

```python
from psycopg import sql

def sql_set_mtdd_tid(tid: str) -> str:
    value = (tid or "").strip()
    if not value:
        raise ValueError("mtdd.tid must be a non-empty string")
    return "SET mtdd.tid = " + sql.quote(value)

def query_with_tid(conn, tid: str, query: str, params=None):
    with conn.cursor() as cur:
        cur.execute(sql_set_mtdd_tid(tid))
        cur.execute(query, params)
        return cur.fetchall()
```

Use a connection from the pool for both statements; do not return the connection between SET and the query.

### Go (`database/sql`)

```go
func QueryWithTid(ctx context.Context, db *sql.DB, tid, query string, args ...any) (*sql.Rows, error) {
    conn, err := db.Conn(ctx)
    if err != nil {
        return nil, err
    }
    defer conn.Close()
    if _, err := conn.ExecContext(ctx, "SET mtdd.tid = '"+strings.ReplaceAll(tid, "'", "''")+"'"); err != nil {
        return nil, err
    }
    return conn.QueryContext(ctx, query, args...)
}
```

Prefer `pq.QuoteLiteral` / a bound `SET mtdd.tid = $1` if your driver sends it as extended protocol (the proxy accepts that).

---

## Health, startup, and jobs

There is no “run on every shard” flag.

**Health / catalog load** — use any non-empty dummy tid (e.g. `mtdd-startup`). Lookup will place it on some shard. That is enough when every shard has the same reference data.

```js
await queryWithTid(process.env.MTDD_STARTUP_SHARD_KEY || 'mtdd-startup', 'SELECT 1')
```

**Maintenance that must touch every shard** — run the statement once per tid you already know lives on distinct shards (real tenant ids from your data). Do not omit SET. Do not call Lookup from the job unless you are debugging.

**Do not** connect around the gateway to “just hit Postgres” from the request path. Fail closed if the VIP is down.

---

## Checklist for a new app

1. Provision one database (or schema) **per shard**; keep them in sync yourself (migrations).
2. Run Lookup (`SHARD_COUNT` = power of 2) and mtdd-proxy (+ HAProxy in the PoC). You do not embed those URLs in query code.
3. Set app `DB_HOST` / `DB_PORT` to the gateway VIP.
4. Wrap the DB access layer so every query goes through `queryWithTid` / `withTidTx`.
5. Derive `tid` from the request (or a dummy for process-wide pings). Normalize before SET.
6. Smoke: two tids that Lookup splits (e.g. `tenant-c` and `tenant-a` for N=2) and assert rows landed on different shard DBs.
7. Never `--require @advcomm/mtdd/register`. That entry always throws.

---

## What MTDD does after SET

1. Bind the tid (proxy intercepts `SET mtdd.tid`; it is not a Postgres GUC on the shard).
2. `POST /lookup` `{ "tid": "…" }` → `{ "hostIndex": n }`.
3. Execute the following statement on shard `n` only.
4. Return native Postgres on the same client socket.
5. Reuse pooled backend connections to that shard (no new TLS/TCP startup per query).

HAProxy is dumb TCP (`pgsql-check` only). It does not parse SQL or tid.

---

## Troubleshooting

| Symptom | Cause |
|---------|--------|
| `mtdd.tid is not set` | SET ran on a different pool checkout, or was omitted |
| `unrecognized configuration parameter "mtdd.tid"` | Client is talking to vanilla Postgres, not the proxy/VIP |
| Both test tenants land on shard 0 | App still pointing at one DB, or not emitting SET |
| Health fails at startup | Health query has no tid — use a dummy |
| `password authentication failed` | App password must match `DB_PASSWORD` on the proxy |
| Lookup 4xx/5xx | Proxy fail-closed; fix Lookup, do not bypass |

Probe without an app:

```bash
PGHOST=127.0.0.1 PGPORT=15432 npm run mtdd-proxy:probe
```

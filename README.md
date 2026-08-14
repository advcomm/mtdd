# @advcomm/mtdd

**MTDD** = Multi-Tenant Database Driver.

A **routing tool**: bind an opaque `tid`, look up a shard, execute the client’s statement on that shard, return native Postgres, reuse backend sessions. It does not require stored procedures or an ORM, and it does not parse what `tid` means.

**Consuming apps:** start at **[INTEGRATION.md](INTEGRATION.md)** (VIP + `SET mtdd.tid` helpers). Do not `--require @advcomm/mtdd/register`.

| Operation | How                                                                                    |
| --------- | -------------------------------------------------------------------------------------- |
| Bind tid  | `SET mtdd.tid = '<opaque>'` on the Postgres wire (same connection as the SQL)          |
| Place     | HTTP Lookup `POST /lookup` `{ tid }` → `{ hostIndex }` (binary-split in `mtdd_lookup`) |
| Execute   | Forward the following SQL (SELECT / INSERT / CALL / …) to one shard                    |
| Return    | Native PG on the same client socket                                                    |
| Reuse     | Backend pool to each shard VIP — **no per-query TLS/TCP startup**                      |

PoC transport: vanilla `pg` → HAProxy GW → **mtdd-proxy** → HAProxy shard → Postgres. A later Rust/QUIC client/agent must keep the same operations. **gRPC QueryStream is not on this path.**

```text
app  →  HAP GW :15432  →  mtdd-proxy :6432  →  HAP shard :15442|:15443  →  Postgres
```

Lab: [`scripts/haproxy/README.md`](scripts/haproxy/README.md). Roadmap: [docs/MTDD-ROADMAP.md](docs/MTDD-ROADMAP.md). Platform notes: [docs/MULTI-TENANT-PLATFORM-REVIEW.md](docs/MULTI-TENANT-PLATFORM-REVIEW.md).

## Quick start (PoC)

```bash
cp .env.example .env
npm run build
npm run mtdd-proxy
```

App env — **one VIP**, not a JSON array of shards:

```env
DB_HOST=127.0.0.1
DB_PORT=15432
```

`SET` and the statement **must share a checkout**. `pool.query('SET …')` then `pool.query(sql)` can use two connections and will fail with `mtdd.tid is not set`. Copy-paste helpers: [INTEGRATION.md](INTEGRATION.md).

```js
const client = await pool.connect();
try {
  await client.query("SET mtdd.tid = 'tenant-c'");
  const result = await client.query('SELECT 1 AS n');
} finally {
  client.release();
}
```

Lookup goldens (`SHARD_COUNT=2`): `tenant-c` → shard 0, `tenant-a` → shard 1.

Proxy env: `MTDD_LOOKUP_URL`, `MTDD_SHARD_HOSTS` (JSON array aligned with Lookup `SHARD_COUNT`), `DB_USER` / `DB_PASSWORD`. See `.env.example`.

`tid: null` fan-out and SELECT merge are **gone**. A statement without `SET mtdd.tid` is a Postgres error. SQL dialect is the app’s problem.

## Developing this package

Source is **TypeScript** under [`src/`](src/). The npm package ships compiled JavaScript in `dist/`.

```bash
npm ci
npm run build
npm test
npm run mtdd-proxy
```

## Legacy in-process executor

`install()` still exists for existing unit tests when `MTDD_LEGACY_INSTALL=1`. It is **not** the production entry. `./register` always throws. The old gRPC QueryStream + `tid` on `pg` query config path is unsupported for new apps.

## License

MIT

# HAProxy + mtdd-proxy lab

App integration (VIP + `SET mtdd.tid` helpers): [`../../INTEGRATION.md`](../../INTEGRATION.md).

HAProxy is a dumb TCP VIP (`pgsql-check` only). Session logs (`HAPROXY_GW first_payload=…`) capture **startup bytes**, not later `SET` / SQL / tid.

## Topology

```text
vanilla pg  →  127.0.0.1:15432 (HAP GW)
            →  127.0.0.1:6432  (mtdd-proxy)
            →  127.0.0.1:15442|15443 (HAP shard)
            →  Postgres :5432  (databases mtdd_shard_0 / mtdd_shard_1)
```

Lookup (binary-split, `SHARD_COUNT=2`) is beside the proxy:

```bash
# from mtdd_lookup
SHARD_COUNT=2 npm start
# POST http://127.0.0.1:9090/lookup  {"tid":"tenant-c"} → {"hostIndex":0}
# tenant-a → 1
```

Without HAProxy, point the probe at the proxy port (`6432`) and set shard hosts to Postgres directly.

## Run

```bash
# 1) two DBs on local Postgres
psql -U postgres -c 'CREATE DATABASE mtdd_shard_0'
psql -U postgres -c 'CREATE DATABASE mtdd_shard_1'

# 2) Lookup
cd ../mtdd_lookup && SHARD_COUNT=2 npm start

# 3) proxy (from this repo, after npm run build)
export MTDD_LOOKUP_URL=http://127.0.0.1:9090/lookup
export MTDD_SHARD_HOSTS='[{"host":"127.0.0.1","port":15442,"database":"mtdd_shard_0"},{"host":"127.0.0.1","port":15443,"database":"mtdd_shard_1"}]'
export DB_USER=postgres
export DB_PASSWORD=root
npm run mtdd-proxy

# 4) HAProxy
haproxy -f scripts/haproxy/haproxy.cfg -d

# 5) probe (no --require)
npx ts-node is not used; after build:
node dist/scripts/haproxy/probe-tid.js
# or: PGHOST=127.0.0.1 PGPORT=15432 npm run mtdd-proxy:probe
```

`first_payload` in HAP logs should not contain `tenant-c` or `SET mtdd.tid`.

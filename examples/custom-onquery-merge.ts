/**
 * Custom fan-out merge via onQuery (no tid).
 *
 *   node examples/lookup-mock-server.js
 *   MTDD_LOOKUP_URL=http://127.0.0.1:9090/lookup \
 *   DB_HOST='["127.0.0.1","127.0.0.2"]' \
 *   node --require @advcomm/mtdd/register examples/custom-onquery-merge.js
 */

const { Pool } = require('pg')
const hooks = require('@advcomm/mtdd/hooks')
const { fanOutOnly } = require('@advcomm/mtdd')

function parseDbHost(value) {
  if (!value) return 'localhost'
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) return JSON.parse(trimmed)
  return trimmed
}

hooks.onQuery = async (req, next) => {
  if (req.tid) {
    return next()
  }

  const shardResults = await fanOutOnly(req.pool, req)
  const total = shardResults.reduce(
    (sum, result) => sum + (result.rowCount ?? 0),
    0,
  )

  return {
    command: 'SELECT',
    rowCount: total,
    oid: null,
    fields: [],
    rows: [{ totalRows: total, shards: shardResults.length }],
  }
}

async function main() {
  const pool = new Pool({
    host: parseDbHost(process.env.DB_HOST),
    port: Number(process.env.DB_PORT || 5432),
  })

  const result = await pool.query('SELECT COUNT(*) FROM metrics')
  console.log('Custom merge result:', result.rows[0])
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

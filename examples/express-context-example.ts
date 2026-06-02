/**
 * Express-style middleware using AsyncLocalStorage context.
 *
 *   DB_HOST='["127.0.0.1"]' \
 *   node --require @advcomm/mtdd/register examples/express-context-example.js
 */

const { Pool } = require('pg')
const { runWithMtddContext } = require('@advcomm/mtdd/context')

function parseDbHost(value) {
  if (!value) {
    return 'localhost'
  }

  const trimmed = value.trim()
  if (trimmed.startsWith('[')) {
    return JSON.parse(trimmed)
  }
  return trimmed
}

function fakeRequestMiddleware(req, res, next) {
  runWithMtddContext(
    {
      tid: req.tid,
      userId: req.user?.id,
      requestId: req.id,
    },
    next,
  )
}

async function main() {
  const pool = new Pool({
    host: parseDbHost(process.env.DB_HOST),
    port: Number(process.env.DB_PORT || 5432),
  })

  const req = { tid: 'tenant-1', id: 'req-99', user: { id: 'user-7' } }
  const res = {}
  let nextCalled = false

  fakeRequestMiddleware(req, res, async () => {
    nextCalled = true
    await pool.query('SELECT 1')
  })

  if (!nextCalled) {
    throw new Error('middleware did not invoke next')
  }

  await pool.end()
  console.log('Context middleware example completed')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

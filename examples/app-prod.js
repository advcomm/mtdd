/**
 * Production: preload MTDD before the app starts.
 *
 *   DB_HOST='["10.0.1.10","10.0.1.11"]' \
 *   node --require @advcomm/mtdd/register examples/app-prod.js
 */

const { Pool } = require('pg')

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

async function main() {
  const hosts = parseDbHost(process.env.DB_HOST)
  const pool = new Pool({
    host: hosts,
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  })

  console.log('Configured hosts:', hosts)
  console.log('Effective pool host:', pool.options.host)
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

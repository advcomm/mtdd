/**
 * Development: run without MTDD preload.
 *
 *   DB_HOST=localhost node examples/app-dev.js
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
  const pool = new Pool({
    host: parseDbHost(process.env.DB_HOST),
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
  })

  console.log('Pool host:', pool.options?.host ?? '(see connection config)')
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

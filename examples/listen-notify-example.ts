/**
 * LISTEN / NOTIFY with @advcomm/mtdd (requires preload in production).
 *
 *   DB_HOST='["10.0.0.1","10.0.0.2"]' MTDD_LOOKUP_URL=... MTDD_GRPC_MOCK=1 \
 *   node --require ../register.js examples/listen-notify-example.js
 */

const { Pool } = require('pg')

async function main() {
  const pool = new Pool({
    host: JSON.parse(process.env.DB_HOST || '["127.0.0.1"]'),
    database: process.env.DB_NAME || 'postgres',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '',
  })

  const client = await pool.connect()

  client.on('notification', (msg) => {
    console.log('notification', msg.channel, msg.payload)
  })

  await client.query('LISTEN demo_channel')
  await pool.query("NOTIFY demo_channel, 'hello from example'")

  await client.query('UNLISTEN demo_channel')
  client.release()
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

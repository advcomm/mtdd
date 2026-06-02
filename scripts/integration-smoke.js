'use strict'

if (process.env.MTDD_INTEGRATION !== '1') {
  console.log('skip integration (set MTDD_INTEGRATION=1)')
  process.exit(0)
}

const path = require('node:path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')

const SERVER = process.env.MTDD_SERVER_ADDR || '127.0.0.1:50051'

function loadNotify() {
  const protoPath = path.join(__dirname, '..', 'proto', 'mtdd.proto')
  const def = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  })
  return grpc.loadPackageDefinition(def).mtdd.MtddNotify
}

async function main() {
  const MtddNotify = loadNotify()
  const client = new MtddNotify(SERVER, grpc.credentials.createInsecure())
  const clientId = `smoke-${Date.now()}`

  await new Promise((resolve, reject) => {
    client.Subscribe(
      { client_id: clientId, channel: 'smoke', tid_scope: '__global__' },
      (err, res) => (err ? reject(err) : resolve(res)),
    )
  })

  console.log(JSON.stringify({ ok: true, clientId }))
  client.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

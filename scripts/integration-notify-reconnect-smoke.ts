'use strict'

/**
 * Exercises client Watch reconnect + re-Subscribe (matches mtdd_server notify_reconnect_smoke.js).
 * Requires a running mtdd_server with MtddNotify on MTDD_SERVER_ADDR.
 */

if (process.env.MTDD_INTEGRATION !== '1') {
  console.log('skip integration (set MTDD_INTEGRATION=1)')
  process.exit(0)
}

const {
  createGrpcNotifyTransport,
} = require('../grpc-notify-client')
const {
  getLogicalClientId,
  addChannelSubscription,
  getChannelSubscriptionsForClientId,
} = require('../notification-registry')
const { EventEmitter } = require('node:events')

const SERVER = process.env.MTDD_SERVER_ADDR || '127.0.0.1:50051'
const CHANNEL = 'reconnect_smoke'
const TID_SCOPE = '__global__'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const target = new EventEmitter()
  const transport = createGrpcNotifyTransport(SERVER)
  const clientId = getLogicalClientId(target)

  addChannelSubscription(target, CHANNEL, TID_SCOPE)
  await transport.subscribe(clientId, CHANNEL, TID_SCOPE)
  await sleep(300)

  const watchCall = transport.watchCalls.get(clientId)
  if (!watchCall) {
    throw new Error('expected active Watch stream')
  }

  const received = []
  target.on('notification', (msg) => received.push(msg))

  watchCall.cancel()
  await sleep(800)

  const subs = getChannelSubscriptionsForClientId(clientId)
  if (subs.length === 0) {
    throw new Error('expected subscriptions in registry for reconnect')
  }

  await transport.subscribe(clientId, CHANNEL, TID_SCOPE)
  await sleep(300)

  const payload = `reconnect-${Date.now()}`
  await transport.publish(CHANNEL, payload, TID_SCOPE)
  await sleep(500)

  const match = received.find((m) => m.payload === payload)
  if (!match) {
    throw new Error(
      `notification not received after reconnect (got ${received.length} messages)`,
    )
  }

  transport.close()
  console.log(
    JSON.stringify({
      ok: true,
      channel: match.channel,
      payload: match.payload,
    }),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

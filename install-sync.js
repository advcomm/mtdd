const { MessageChannel, receiveMessageOnPort } = require('node:worker_threads')

function settlePromiseSync(promise) {
  if (!promise || typeof promise.then !== 'function') {
    return promise
  }

  const { port1, port2 } = new MessageChannel()
  let result
  let error

  promise.then(
    (value) => {
      result = value
      port1.postMessage(null)
    },
    (err) => {
      error = err
      port1.postMessage(null)
    },
  )

  receiveMessageOnPort(port2)

  if (error) {
    throw error
  }

  return result
}

module.exports = {
  settlePromiseSync,
}

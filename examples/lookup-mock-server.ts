/**
 * Minimal stateless lookup server for local testing.
 *
 *   node examples/lookup-mock-server.js
 *
 * Then:
 *   MTDD_LOOKUP_URL=http://127.0.0.1:9090/lookup \
 *   DB_HOST='["127.0.0.1","127.0.0.2"]' \
 *   node --require @advcomm/mtdd/register your-app.js
 */

const http = require('node:http')

const port = Number(process.env.MTDD_LOOKUP_PORT || 9090)

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.statusCode = 405
    res.end()
    return
  }

  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      res.statusCode = 400
      res.end('invalid json')
      return
    }

    const tid = body.tid ?? ''
    const hostIndex = Math.abs(hashString(tid)) % 2

    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ hostIndex }))
  })
})

function hashString(value) {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0
  }
  return hash
}

server.listen(port, '127.0.0.1', () => {
  console.log(`Lookup mock listening on http://127.0.0.1:${port}/lookup`)
})

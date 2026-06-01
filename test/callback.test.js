const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createMockPg } = require('./helpers')
const { install } = require('../patch')
const { resetHostCounter } = require('../host-selector')

describe('callback passthrough', () => {
  beforeEach(() => {
    resetHostCounter()
    process.env.DB_HOST = '["127.0.0.1"]'
  })

  it('supports pool.query(text, callback)', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })

    await new Promise((resolve, reject) => {
      pool.query('SELECT 1', (err, result) => {
        if (err) reject(err)
        else {
          assert.equal(result.command, 'SELECT')
          resolve()
        }
      })
    })
  })

  it('supports pool.query(text, values, callback)', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })

    await new Promise((resolve, reject) => {
      pool.query('SELECT $1', [1], (err, result) => {
        if (err) reject(err)
        else {
          assert.equal(result.command, 'SELECT')
          resolve()
        }
      })
    })
  })

  it('supports client.query with callback from pool.connect', async () => {
    const { pg } = createMockPg()
    install(pg)

    const pool = new pg.Pool({ host: '127.0.0.1' })
    const client = await pool.connect()

    await new Promise((resolve, reject) => {
      client.query('SELECT 1', (err, result) => {
        client.release()
        if (err) reject(err)
        else {
          assert.equal(result.command, 'SELECT')
          resolve()
        }
      })
    })
  })
})

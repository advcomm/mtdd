const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { createMockPg } = require('./helpers')
const { install, PATCHED } = require('../patch')
const { resetHostCounter } = require('../host-selector')

describe('host selection', () => {
  beforeEach(() => {
    resetHostCounter()
    process.env.DB_HOST = '["10.0.1.10","10.0.1.11","10.0.1.12"]'
  })

  it('replaces host array with a single IP for Pool', () => {
    const { pg, state } = createMockPg()
    install(pg)

    new pg.Pool({
      host: ['10.0.1.10', '10.0.1.11'],
      port: 5432,
    })

    assert.equal(state.pools.length, 1)
    assert.equal(typeof state.pools[0].config.host, 'string')
    assert.ok(['10.0.1.10', '10.0.1.11'].includes(state.pools[0].config.host))
  })

  it('replaces host array with a single IP for Client', () => {
    const { pg, state } = createMockPg()
    install(pg)

    new pg.Client({
      host: ['10.0.1.10', '10.0.1.11'],
    })

    assert.equal(state.clients.length, 1)
    assert.equal(typeof state.clients[0].config.host, 'string')
  })

  it('does not double-patch pg', () => {
    const { pg } = createMockPg()
    install(pg)
    install(pg)
    assert.equal(pg[PATCHED], true)
  })
})

describe('round-robin host selection', () => {
  beforeEach(() => {
    resetHostCounter()
    process.env.DB_HOST = '["10.0.1.10","10.0.1.11"]'
  })

  it('distributes hosts across successive Pool instances', () => {
    const { pg, state } = createMockPg()
    install(pg)

    const hosts = ['10.0.1.10', '10.0.1.11']
    const config = { host: hosts }

    new pg.Pool(config)
    new pg.Pool(config)
    new pg.Pool(config)
    new pg.Pool(config)

    const selected = state.pools.map((p) => p.config.host)
    assert.deepEqual(selected, [
      '10.0.1.10',
      '10.0.1.11',
      '10.0.1.10',
      '10.0.1.11',
    ])
  })
})

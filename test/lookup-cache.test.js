const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { clearLookupCache } = require('../lookup-cache')
const { lookupHostIndex } = require('../lookup-client')
const hooks = require('../hooks')

describe('lookup cache', () => {
  beforeEach(() => {
    clearLookupCache()
    process.env.MTDD_LOOKUP_CACHE_TTL_MS = '60000'
    let calls = 0
    hooks.onLookup = async () => {
      calls += 1
      return 1
    }
    hooks._testCalls = () => calls
  })

  afterEach(() => {
    delete process.env.MTDD_LOOKUP_CACHE_TTL_MS
    hooks.onLookup = async (req, next) => next()
    delete hooks._testCalls
    clearLookupCache()
  })

  it('caches tid to hostIndex within TTL', async () => {
    assert.equal(await lookupHostIndex('tenant-a', 3), 1)
    assert.equal(await lookupHostIndex('tenant-a', 3), 1)
    assert.equal(hooks._testCalls(), 1)
  })
})

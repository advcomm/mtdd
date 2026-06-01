const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  parseHostArray,
  normalizeHostEntry,
  getWriteHost,
  getReadHosts,
} = require('../host-config')

describe('host-config', () => {
  it('normalizes string entries to write-only hosts', () => {
    assert.deepEqual(normalizeHostEntry('10.0.1.10', 0, 'DB_HOST'), {
      write: '10.0.1.10',
      read: [],
    })
  })

  it('uses the same IP for read routing when entry is a string', () => {
    const { resolveHostIp } = require('../shard-endpoints')
    const entry = normalizeHostEntry('10.0.1.10', 0, 'DB_HOST')
    const counters = {}

    assert.equal(resolveHostIp(entry, 'write', counters, 0), '10.0.1.10')
    assert.equal(resolveHostIp(entry, 'read', counters, 0), '10.0.1.10')
    assert.equal(resolveHostIp(entry, 'read', counters, 0), '10.0.1.10')
  })

  it('normalizes objects with write and read arrays', () => {
    assert.deepEqual(
      normalizeHostEntry(
        { write: '10.0.1.1', read: ['10.0.1.2', '10.0.1.3'] },
        0,
        'DB_HOST',
      ),
      {
        write: '10.0.1.1',
        read: ['10.0.1.2', '10.0.1.3'],
      },
    )
  })

  it('accepts reads as an alias for read', () => {
    assert.deepEqual(
      normalizeHostEntry(
        { write: '10.0.1.1', reads: ['10.0.1.2'] },
        0,
        'DB_HOST',
      ),
      {
        write: '10.0.1.1',
        read: ['10.0.1.2'],
      },
    )
  })

  it('throws when object is missing write', () => {
    assert.throws(
      () => parseHostArray([{ read: ['10.0.1.2'] }], 'DB_HOST'),
      /must include a "write"/i,
    )
  })

  it('getWriteHost and getReadHosts work on normalized entries', () => {
    const entry = { write: '10.0.0.1', read: ['10.0.0.2'] }
    assert.equal(getWriteHost(entry), '10.0.0.1')
    assert.deepEqual(getReadHosts(entry), ['10.0.0.2'])
  })
})

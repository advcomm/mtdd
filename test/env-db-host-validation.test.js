const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { runRegister } = require('./helpers')

describe('DB_HOST validation when @advcomm/mtdd/register loads', () => {
  it('throws when DB_HOST is missing', () => {
    const result = runRegister({ DB_HOST: undefined })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /DB_HOST is required/i)
  })

  it('throws when DB_NAME is missing', () => {
    const result = runRegister({
      DB_HOST: '["10.0.1.10"]',
      DB_NAME: undefined,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /DB_NAME is required/i)
  })

  it('throws when MTDD_LOOKUP_URL is missing', () => {
    const result = runRegister({
      DB_HOST: '["10.0.1.10"]',
      MTDD_LOOKUP_URL: undefined,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /MTDD_LOOKUP_URL is required/i)
  })

  it('throws when DB_HOST is localhost (not JSON array)', () => {
    const result = runRegister({ DB_HOST: 'localhost' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /DB_HOST must be valid JSON/i)
  })

  it('throws when DB_HOST contains a hostname in the array', () => {
    const result = runRegister({
      DB_HOST: '["postgres.example.com"]',
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must be an IPv4 or IPv6 address/i)
  })

  it('throws when DB_HOST is a single IP string (not JSON array)', () => {
    const result = runRegister({ DB_HOST: '10.0.1.10' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must be valid JSON|must be a JSON array/i)
  })

  it('accepts a valid JSON array of IP addresses', () => {
    const result = runRegister({
      DB_HOST: '["10.0.1.10","10.0.1.11"]',
    })
    assert.equal(result.status, 0, result.stderr)
  })

  it('accepts IPv6 addresses in the array', () => {
    const result = runRegister({
      DB_HOST: '["2001:db8::1"]',
    })
    assert.equal(result.status, 0, result.stderr)
  })

  it('throws when DB_HOST is an empty array', () => {
    const result = runRegister({ DB_HOST: '[]' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /must not be empty/i)
  })
})

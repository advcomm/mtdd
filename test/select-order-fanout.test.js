const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { splitSelectForOrderedFanOut } = require('../select-order-fanout')
const { rewriteQueryTableName } = require('../postgres-select-merge')
const { MtddSqlParseError } = require('../sql-parse')

describe('splitSelectForOrderedFanOut', () => {
  it('returns needsLocalReorder false when there is no ORDER BY', () => {
    const split = splitSelectForOrderedFanOut(
      'SELECT id FROM users WHERE active = true',
    )
    assert.equal(split.needsLocalReorder, false)
  })

  it('strips ORDER BY and LIMIT from fan-out SQL', () => {
    const split = splitSelectForOrderedFanOut(
      'SELECT id, name FROM users WHERE active = true ORDER BY name DESC LIMIT 10',
    )
    assert.equal(split.needsLocalReorder, true)
    assert.equal(split.tempTableName, 'users')
    assert.match(split.fanOutText, /FROM users/i)
    assert.doesNotMatch(split.fanOutText, /ORDER BY/i)
    assert.doesNotMatch(split.fanOutText, /LIMIT/i)
    assert.equal(
      split.fullText,
      'SELECT id, name FROM users WHERE active = true ORDER BY name DESC LIMIT 10',
    )
  })

  it('throws for JOIN queries with ORDER BY', () => {
    assert.throws(
      () =>
        splitSelectForOrderedFanOut(
          'SELECT u.id FROM users u JOIN orders o ON o.user_id = u.id ORDER BY u.id',
        ),
      MtddSqlParseError,
    )
  })

  it('rejects ORDER BY fan-out when SQL includes OFFSET', () => {
    assert.throws(
      () =>
        splitSelectForOrderedFanOut(
          'SELECT id FROM users ORDER BY id LIMIT 10 OFFSET 20',
        ),
      (err) => {
        assert.equal(err.name, 'MtddSqlParseError')
        assert.match(err.message, /OFFSET is not supported/i)
        return true
      },
    )
  })
})

describe('rewriteQueryTableName', () => {
  it('replaces the primary table in FROM for local reorder', () => {
    const sql =
      'SELECT id FROM users WHERE active = true ORDER BY id DESC LIMIT 5'
    const rewritten = rewriteQueryTableName(sql, 'users', 'users_mtdd_abcd')
    assert.match(rewritten, /FROM "users_mtdd_abcd"/i)
    assert.doesNotMatch(rewritten, /\bFROM users\b/i)
    assert.match(rewritten, /ORDER BY id DESC/i)
  })
})

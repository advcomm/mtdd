const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const {
  splitSelectForLocalFanOut,
  splitSelectForOrderedFanOut,
  selectHasSupportedAggregates,
  parseSelectStatement,
} = require('../select-local-fanout')
const { MtddSqlParseError } = require('../sql-parse')

describe('splitSelectForLocalFanOut aggregates', () => {
  it('returns needsLocalMerge false for plain SELECT without ORDER BY or aggregates', () => {
    const split = splitSelectForLocalFanOut(
      'SELECT id, name FROM users WHERE active = true',
    )
    assert.equal(split.needsLocalMerge, false)
    assert.equal(split.needsLocalReorder, false)
  })

  it('rewrites scalar SUM to row-level amount projection', () => {
    const split = splitSelectForLocalFanOut('SELECT SUM(amount) FROM orders')
    assert.equal(split.needsLocalMerge, true)
    assert.equal(split.hasAggregates, true)
    assert.match(split.fanOutText, /SELECT amount/i)
    assert.doesNotMatch(split.fanOutText, /\bSUM\b/i)
    assert.doesNotMatch(split.fanOutText, /GROUP BY/i)
  })

  it('rewrites grouped aggregates to GROUP BY columns and aggregate args', () => {
    const split = splitSelectForLocalFanOut(
      'SELECT region, SUM(amount), MIN(x), MAX(y) FROM orders GROUP BY region',
    )
    assert.equal(split.hasAggregates, true)
    assert.match(split.fanOutText, /SELECT region , amount , x , y/i)
    assert.doesNotMatch(split.fanOutText, /GROUP BY/i)
    assert.doesNotMatch(split.fanOutText, /\bSUM\b/i)
  })

  it('supports AVG via row-level projection', () => {
    const split = splitSelectForLocalFanOut('SELECT AVG(price) FROM products')
    assert.equal(split.hasAggregates, true)
    assert.match(split.fanOutText, /SELECT price/i)
    assert.doesNotMatch(split.fanOutText, /\bAVG\b/i)
  })

  it('supports COUNT(*) with a row marker column for fan-out', () => {
    const split = splitSelectForLocalFanOut('SELECT COUNT(*) FROM t')
    assert.equal(split.hasAggregates, true)
    assert.match(split.fanOutText, /_mtdd_row/i)
    assert.doesNotMatch(split.fanOutText, /\bCOUNT\b/i)
  })

  it('collects HAVING aggregate argument columns into fan-out projection', () => {
    const split = splitSelectForLocalFanOut(
      'SELECT region FROM orders GROUP BY region HAVING SUM(amount) > 10',
    )
    assert.equal(split.hasAggregates, true)
    assert.match(split.fanOutText, /region/i)
    assert.match(split.fanOutText, /amount/i)
    assert.doesNotMatch(split.fanOutText, /HAVING/i)
  })

  it('handles ORDER BY and aggregates together', () => {
    const split = splitSelectForLocalFanOut(
      'SELECT region, SUM(amount) FROM orders GROUP BY region ORDER BY region LIMIT 10',
    )
    assert.equal(split.needsLocalMerge, true)
    assert.equal(split.hasAggregates, true)
    assert.match(split.fanOutText, /SELECT region , amount/i)
    assert.doesNotMatch(split.fanOutText, /ORDER BY/i)
    assert.doesNotMatch(split.fanOutText, /LIMIT/i)
    assert.equal(split.fullText.includes('ORDER BY region'), true)
  })

  it('strips ORDER BY only when there are no aggregates', () => {
    const split = splitSelectForLocalFanOut(
      'SELECT id, name FROM users WHERE active = true ORDER BY name DESC LIMIT 10',
    )
    assert.equal(split.needsLocalMerge, true)
    assert.equal(split.hasAggregates, false)
    assert.match(split.fanOutText, /FROM users/i)
    assert.doesNotMatch(split.fanOutText, /ORDER BY/i)
  })

  it('throws for JOIN queries with aggregates', () => {
    assert.throws(
      () =>
        splitSelectForLocalFanOut(
          'SELECT SUM(o.amount) FROM orders o JOIN customers c ON c.id = o.customer_id',
        ),
      MtddSqlParseError,
    )
  })

  it('rejects OFFSET for local fan-out', () => {
    assert.throws(
      () =>
        splitSelectForLocalFanOut(
          'SELECT SUM(amount) FROM orders ORDER BY amount LIMIT 10 OFFSET 5',
        ),
      (err) => {
        assert.equal(err.name, 'MtddSqlParseError')
        assert.match(err.message, /OFFSET is not supported/i)
        return true
      },
    )
  })

  it('selectHasSupportedAggregates detects stddev', () => {
    const { select } = parseSelectStatement(
      'SELECT STDDEV_POP(amount) FROM orders',
    )
    assert.equal(selectHasSupportedAggregates(select), true)
  })

  it('splitSelectForOrderedFanOut is an alias for splitSelectForLocalFanOut', () => {
    const sql = 'SELECT id FROM users ORDER BY id'
    assert.deepEqual(splitSelectForOrderedFanOut(sql), splitSelectForLocalFanOut(sql))
  })
})

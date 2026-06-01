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

  it('rewrites bool_and to row-level projection', () => {
    const split = splitSelectForLocalFanOut('SELECT bool_and(ok) FROM t')
    assert.equal(split.needsLocalMerge, true)
    assert.match(split.fanOutText, /\bok\b/i)
    assert.doesNotMatch(split.fanOutText, /bool_and/i)
  })

  it('rewrites string_agg when ORDER BY is inside the aggregate', () => {
    const split = splitSelectForLocalFanOut(
      "SELECT string_agg(name, ',' ORDER BY name) FROM t GROUP BY region",
    )
    assert.equal(split.needsLocalMerge, true)
    assert.match(split.fanOutText, /name/i)
    assert.doesNotMatch(split.fanOutText, /string_agg/i)
  })

  it('rewrites percentile_cont with WITHIN GROUP columns', () => {
    const split = splitSelectForLocalFanOut(
      'SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY amount) FROM orders',
    )
    assert.equal(split.needsLocalMerge, true)
    assert.match(split.fanOutText, /amount/i)
    assert.doesNotMatch(split.fanOutText, /percentile_cont/i)
  })

  it('rewrites corr and collects both argument columns', () => {
    const split = splitSelectForLocalFanOut(
      'SELECT corr(y, x) FROM metrics',
    )
    assert.match(split.fanOutText, /\by\b/i)
    assert.match(split.fanOutText, /\bx\b/i)
  })

  it('collects FILTER and DISTINCT aggregate columns', () => {
    const split = splitSelectForLocalFanOut(
      'SELECT sum(amount) FILTER (WHERE active), count(DISTINCT user_id) FROM orders',
    )
    assert.match(split.fanOutText, /amount/i)
    assert.match(split.fanOutText, /active/i)
    assert.match(split.fanOutText, /user_id/i)
  })

  it('rejects window functions', () => {
    assert.throws(
      () => splitSelectForLocalFanOut('SELECT sum(x) OVER () FROM t'),
      (err) => {
        assert.equal(err.name, 'MtddSqlParseError')
        assert.match(err.message, /window functions/i)
        return true
      },
    )
  })

  it('rejects string_agg without per-aggregate ORDER BY', () => {
    assert.throws(
      () =>
        splitSelectForLocalFanOut(
          "SELECT string_agg(name, ',') FROM t GROUP BY region",
        ),
      (err) => {
        assert.match(err.message, /string_agg.*ORDER BY within the aggregate/i)
        return true
      },
    )
  })

  it('rejects any_value aggregate', () => {
    assert.throws(
      () => splitSelectForLocalFanOut('SELECT any_value(x) FROM t'),
      (err) => {
        assert.match(err.message, /any_value/i)
        return true
      },
    )
  })

  it('rejects hypothetical-set rank aggregate', () => {
    assert.throws(
      () =>
        splitSelectForLocalFanOut(
          'SELECT rank(1) WITHIN GROUP (ORDER BY x) FROM t',
        ),
      (err) => {
        assert.match(err.message, /\brank\b/i)
        return true
      },
    )
  })

  it('rejects unknown user-defined aggregates with GROUP BY', () => {
    assert.throws(
      () =>
        splitSelectForLocalFanOut(
          'SELECT region, my_agg(amount) FROM orders GROUP BY region',
        ),
      (err) => {
        assert.match(err.message, /my_agg/i)
        return true
      },
    )
  })

  it('rejects subqueries inside aggregate arguments', () => {
    assert.throws(
      () => splitSelectForLocalFanOut('SELECT sum((SELECT 1)) FROM t'),
      (err) => {
        assert.match(err.message, /subqueries/i)
        return true
      },
    )
  })
})

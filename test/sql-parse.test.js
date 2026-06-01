const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  classifyQuery,
  MtddSqlParseError,
  clearClassificationCache,
} = require('../sql-parse')

describe('sql-parse AST classification', () => {
  beforeEach(() => {
    clearClassificationCache()
  })

  it('classifies DML inside WITH from AST', () => {
    assert.deepEqual(
      classifyQuery(
        'WITH stale AS (SELECT id FROM users) UPDATE users u SET active = false FROM stale s WHERE u.id = s.id RETURNING u.id',
      ),
      {
        commandType: 'UPDATE',
        hasReturning: true,
      },
    )
  })

  it('classifies DML with RETURNING from AST', () => {
    assert.deepEqual(
      classifyQuery('DELETE FROM users WHERE active = false'),
      {
        commandType: 'DELETE',
        hasReturning: false,
      },
    )

    assert.deepEqual(
      classifyQuery('UPDATE users SET active = false WHERE id = $1 RETURNING id'),
      {
        commandType: 'UPDATE',
        hasReturning: true,
      },
    )

    assert.deepEqual(
      classifyQuery('INSERT INTO users (name) VALUES ($1) RETURNING id, name'),
      {
        commandType: 'INSERT',
        hasReturning: true,
      },
    )
  })

  it('classifies CALL without using the SQL parser', () => {
    assert.deepEqual(classifyQuery('CALL create_invoice($1, $2)'), {
      commandType: 'CALL',
      hasReturning: false,
    })

    assert.deepEqual(
      classifyQuery(
        'WITH params AS (SELECT $1::int AS id) CALL refresh_summary($1)',
      ),
      {
        commandType: 'CALL',
        hasReturning: false,
      },
    )
  })

  it('classifies SELECT vs stored function from AST', () => {
    assert.deepEqual(
      classifyQuery('SELECT * FROM calculate_commission($1, $2)'),
      {
        commandType: 'FUNCTION',
        hasReturning: false,
      },
    )

    assert.deepEqual(classifyQuery('SELECT app.get_balance($1)'), {
      commandType: 'FUNCTION',
      hasReturning: false,
    })

    assert.deepEqual(classifyQuery('SELECT * FROM users WHERE id = $1'), {
      commandType: 'SELECT',
      hasReturning: false,
    })

    assert.deepEqual(classifyQuery('SELECT * FROM (SELECT 1 AS n) sub'), {
      commandType: 'SELECT',
      hasReturning: false,
    })
  })

  it('handles comments and classifies SELECT with tid-style queries', () => {
    assert.deepEqual(classifyQuery('/* tenant lookup */ SELECT 1'), {
      commandType: 'SELECT',
      hasReturning: false,
    })
  })

  it('returns UNKNOWN for empty text', () => {
    assert.deepEqual(classifyQuery(''), {
      commandType: 'UNKNOWN',
      hasReturning: false,
    })
  })

  it('throws MtddSqlParseError on invalid SQL', () => {
    assert.throws(
      () => classifyQuery('NOT VALID SQL AT ALL'),
      (err) => err instanceof MtddSqlParseError && /unable to parse SQL/i.test(err.message),
    )
  })

  it('throws MtddSqlParseError on multi-statement SQL', () => {
    assert.throws(
      () => classifyQuery('SELECT 1; SELECT 2'),
      (err) =>
        err instanceof MtddSqlParseError &&
        /multi-statement SQL is not supported/i.test(err.message),
    )
  })

  it('caches classification by exact SQL text', () => {
    const sql = 'SELECT * FROM users WHERE id = $1'
    const first = classifyQuery(sql)
    const second = classifyQuery(sql)
    assert.deepEqual(first, second)
    assert.equal(first.commandType, 'SELECT')
  })
})

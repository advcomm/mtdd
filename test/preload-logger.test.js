const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const {
  resolvePreloadEnv,
  resolveLogLevel,
  resolveLogBackend,
  getPreloadLogConfig,
  resetPreloadLogConfigForTests,
  redactCredentials,
  logInfo,
} = require('../preload-logger')

describe('preload-logger', () => {
  let restoreEnv

  beforeEach(() => {
    restoreEnv = snapshotEnv([
      'NODE_ENV',
      'MTDD_GRPC_MOCK',
      'MTDD_PRELOAD_LOG_LEVEL',
      'MTDD_LOG_BACKEND',
      'MTDD_LOG_OTEL',
    ])
    resetPreloadLogConfigForTests()
  })

  afterEach(() => {
    restoreEnv()
    resetPreloadLogConfigForTests()
  })

  it('maps NODE_ENV to dev, test, staging, and prod', () => {
    process.env.NODE_ENV = 'development'
    assert.equal(resolvePreloadEnv(), 'dev')
    process.env.NODE_ENV = 'test'
    assert.equal(resolvePreloadEnv(), 'test')
    process.env.NODE_ENV = 'staging'
    assert.equal(resolvePreloadEnv(), 'staging')
    process.env.NODE_ENV = 'production'
    assert.equal(resolvePreloadEnv(), 'prod')
  })

  it('defaults to test when MTDD_GRPC_MOCK is set and NODE_ENV is unknown', () => {
    delete process.env.NODE_ENV
    process.env.MTDD_GRPC_MOCK = '1'
    assert.equal(resolvePreloadEnv(), 'test')
  })

  it('uses environment default log levels', () => {
    process.env.NODE_ENV = 'development'
    resetPreloadLogConfigForTests()
    assert.equal(resolveLogLevel('dev'), 'debug')
    process.env.NODE_ENV = 'test'
    resetPreloadLogConfigForTests()
    assert.equal(resolveLogLevel('test'), 'warn')
    process.env.NODE_ENV = 'staging'
    resetPreloadLogConfigForTests()
    assert.equal(resolveLogLevel('staging'), 'info')
    process.env.NODE_ENV = 'production'
    resetPreloadLogConfigForTests()
    assert.equal(resolveLogLevel('prod'), 'info')
  })

  it('honors MTDD_PRELOAD_LOG_LEVEL override', () => {
    process.env.NODE_ENV = 'production'
    process.env.MTDD_PRELOAD_LOG_LEVEL = 'debug'
    resetPreloadLogConfigForTests()
    assert.equal(getPreloadLogConfig().level, 'debug')
  })

  it('uses console backend in non-production even when otel is requested', () => {
    process.env.NODE_ENV = 'staging'
    process.env.MTDD_LOG_BACKEND = 'otel'
    resetPreloadLogConfigForTests()
    assert.equal(resolveLogBackend('staging'), 'console')
  })

  it('allows otel backend in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.MTDD_LOG_OTEL = '1'
    resetPreloadLogConfigForTests()
    assert.equal(getPreloadLogConfig().backend, 'otel')
  })

  it('redacts passwords in credential summaries', () => {
    const redacted = redactCredentials({
      database: 'app',
      user: 'u',
      password: 'secret',
      port: 5432,
    })
    assert.equal(redacted.password, '[REDACTED]')
    assert.equal(redacted.database, 'app')
  })

  it('emits structured JSON in staging', () => {
    process.env.NODE_ENV = 'staging'
    resetPreloadLogConfigForTests()
    const lines = captureWrites(() => {
      logInfo('test message', { shardCount: 2 })
    })
    assert.equal(lines.length, 1)
    const parsed = JSON.parse(lines[0])
    assert.equal(parsed.level, 'info')
    assert.equal(parsed.msg, 'test message')
    assert.equal(parsed.shardCount, 2)
    assert.equal(parsed.env, 'staging')
  })

  it('suppresses info logs in test environment by default', () => {
    process.env.NODE_ENV = 'test'
    resetPreloadLogConfigForTests()
    const lines = captureWrites(() => {
      logInfo('should not appear', {})
    })
    assert.equal(lines.length, 0)
  })
})

function snapshotEnv(keys) {
  const previous = {}
  for (const key of keys) {
    previous[key] = process.env[key]
  }
  return () => {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = previous[key]
      }
    }
  }
}

function captureWrites(fn) {
  const lines = []
  const original = process.stdout.write
  process.stdout.write = (chunk) => {
    lines.push(String(chunk).trim())
    return true
  }
  try {
    fn()
  } finally {
    process.stdout.write = original
  }
  return lines
}

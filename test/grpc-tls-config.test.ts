const { describe, it, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  validateGrpcTlsConfig,
  validateTlsEnvConfig,
  resolveTlsEnv,
} = require('../src/grpc-tls')

describe('grpc tls config', () => {
  let tmpDir
  const saved: Record<string, string | undefined> = {}

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        if (value !== undefined) process.env[key] = value
      }
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  function saveEnv(key, value) {
    saved[key] = process.env[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }

  it('returns insecure mode when TLS is not configured', () => {
    saveEnv('MTDD_GRPC_TLS', undefined)
    saveEnv('MTDD_GRPC_TLS_CA_FILE', undefined)
    const result = validateGrpcTlsConfig()
    assert.equal(result.mode, 'insecure')
  })

  it('requires CA file when MTDD_GRPC_TLS=1', () => {
    saveEnv('MTDD_GRPC_TLS', '1')
    saveEnv('MTDD_GRPC_TLS_CA_FILE', undefined)
    assert.throws(() => validateGrpcTlsConfig(), /MTDD_GRPC_TLS_CA_FILE/)
  })

  it('validates CA file exists', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtdd-tls-'))
    const caPath = path.join(tmpDir, 'ca.pem')
    fs.writeFileSync(caPath, 'dummy-ca')

    saveEnv('MTDD_GRPC_TLS', '1')
    saveEnv('MTDD_GRPC_TLS_CA_FILE', caPath)
    saveEnv('MTDD_GRPC_TLS_CERT_FILE', undefined)
    saveEnv('MTDD_GRPC_TLS_KEY_FILE', undefined)

    const result = validateGrpcTlsConfig()
    assert.equal(result.mode, 'tls')
    assert.equal(result.mTLS, false)
  })

  it('requires cert and key together for mTLS', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mtdd-tls-'))
    const caPath = path.join(tmpDir, 'ca.pem')
    const certPath = path.join(tmpDir, 'cert.pem')
    fs.writeFileSync(caPath, 'ca')
    fs.writeFileSync(certPath, 'cert')

    saveEnv('MTDD_GRPC_TLS_CA_FILE', caPath)
    saveEnv('MTDD_GRPC_TLS_CERT_FILE', certPath)
    saveEnv('MTDD_GRPC_TLS_KEY_FILE', undefined)

    assert.throws(
      () => validateTlsEnvConfig(resolveTlsEnv('MTDD_GRPC_TLS')),
      /must both be set for mTLS/,
    )
  })
})

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const distSrc = path.join(__dirname, '..', 'src')
const repoSrc = path.join(__dirname, '..', '..', 'src')
const repoRoot = path.join(__dirname, '..', '..')

const REQUIRED_DIST_MODULES = [
  'index.js',
  'register.js',
  'patch.js',
  'query-executor.js',
  'grpc-hub.js',
  'proto-path.js',
  'pool-facade.js',
  'listen-notify-handler.js',
  'grpc-query-codec.js',
]

const REQUIRED_RUNTIME_EXPORTS = [
  'install',
  'shutdownMtdd',
  'registerAutoShutdown',
  'classifyQuery',
  'mergeFanOutResults',
  'fanOutOnly',
  'validateEnvDbHost',
  'validateLookupUrl',
  'hooks',
  'parseListenNotifyStatement',
  'runWithMtddContext',
  'getMtddContext',
]

describe('TypeScript build artifacts', () => {
  it('emits required compiled modules under dist/src', () => {
    for (const file of REQUIRED_DIST_MODULES) {
      const full = path.join(distSrc, file)
      assert.ok(fs.existsSync(full), `missing dist output: ${file}`)
      assert.ok(fs.statSync(full).size > 0, `empty dist output: ${file}`)
    }
  })

  it('emits source maps for main entry', () => {
    assert.ok(fs.existsSync(path.join(distSrc, 'index.js.map')))
  })

  it('ships public-api.d.ts for consumers', () => {
    const apiTypes = path.join(repoSrc, 'public-api.d.ts')
    assert.ok(fs.existsSync(apiTypes))
    const text = fs.readFileSync(apiTypes, 'utf8')
    assert.match(text, /export function install/)
    assert.match(text, /export interface MtddQueryConfig/)
  })

  it('compiles every non-types src/*.ts to dist/src/*.js', () => {
    const skip = new Set(['public-api.d.ts'])
    const srcFiles = fs
      .readdirSync(repoSrc)
      .filter(
        (f) =>
          f.endsWith('.ts') &&
          !f.endsWith('.d.ts') &&
          !skip.has(f) &&
          !fs.statSync(path.join(repoSrc, f)).isDirectory(),
      )

    const missing = []
    for (const file of srcFiles) {
      const jsName = file.replace(/\.ts$/, '.js')
      if (!fs.existsSync(path.join(distSrc, jsName))) {
        missing.push(jsName)
      }
    }

    assert.deepEqual(
      missing,
      [],
      `src modules missing from dist: ${missing.join(', ')}`,
    )
  })

  it('compiles flatbuffers codec to dist', () => {
    assert.ok(
      fs.existsSync(
        path.join(distSrc, 'flatbuffers', 'result-meta-codec.js'),
      ),
    )
  })

  it('keeps proto at package root for runtime loading', () => {
    assert.ok(fs.existsSync(path.join(repoRoot, 'proto', 'mtdd.proto')))
  })
})

describe('dist runtime exports (post-tsc)', () => {
  it('index.js exposes the public API surface', () => {
    const mtdd = require('../src/index')
    for (const name of REQUIRED_RUNTIME_EXPORTS) {
      assert.ok(
        mtdd[name] !== undefined,
        `missing export on require("@advcomm/mtdd"): ${name}`,
      )
    }
    assert.equal(typeof mtdd.install, 'function')
    assert.equal(typeof mtdd.hooks.onQuery, 'function')
  })
})

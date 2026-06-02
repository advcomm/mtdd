const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { withTestEnv, runRegister } = require('./helpers')

const packageRoot = path.join(__dirname, '..', '..')
const pkg = JSON.parse(
  fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
)

function resolveExportTarget(subpath: string): string {
  const entry = pkg.exports[subpath]
  const rel =
    typeof entry === 'string'
      ? entry
      : typeof entry === 'object' && entry && 'default' in entry
        ? entry.default
        : null
  assert.ok(rel, `missing exports[${JSON.stringify(subpath)}]`)
  return path.join(packageRoot, rel.replace(/^\.\//, ''))
}

describe('package.json exports resolve to dist', () => {
  it('main entry loads from dist/src/index.js', () => {
    const mainPath = resolveExportTarget('.')
    assert.match(mainPath, /dist[\\/]src[\\/]index\.js$/)
    const mtdd = require(mainPath)
    assert.equal(typeof mtdd.install, 'function')
  })

  it('register subpath points at dist/src/register.js', () => {
    const registerPath = resolveExportTarget('./register')
    assert.match(registerPath, /dist[\\/]src[\\/]register\.js$/)
    assert.ok(fs.existsSync(registerPath))
  })

  it('context subpath exports AsyncLocalStorage helpers', () => {
    const ctx = require(resolveExportTarget('./context'))
    assert.equal(typeof ctx.runWithMtddContext, 'function')
    assert.equal(typeof ctx.getMtddContext, 'function')
  })

  it('hooks subpath exports hook handlers', () => {
    const hooks = require(resolveExportTarget('./hooks'))
    assert.equal(typeof hooks.onQuery, 'function')
    assert.equal(typeof hooks.onLookup, 'function')
  })

  it('types field points at public-api.d.ts', () => {
    const typesPath = path.join(packageRoot, pkg.types)
    assert.ok(fs.existsSync(typesPath))
    const text = fs.readFileSync(typesPath, 'utf8')
    assert.match(text, /export function install/)
  })
})

describe('register preload via package export', () => {
  let restore: (() => void) | undefined

  before(() => {
    restore = withTestEnv({
      DB_HOST: '["127.0.0.1"]',
      MTDD_GRPC_MOCK: '1',
    })
  })

  after(() => {
    restore?.()
  })

  it('register.js preload succeeds when spawned like production', () => {
    const result = runRegister({
      DB_HOST: '["127.0.0.1"]',
      MTDD_GRPC_MOCK: '1',
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })
})

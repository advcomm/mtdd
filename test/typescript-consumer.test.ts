const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const packageRoot = path.join(__dirname, '..', '..')
const tscPath = require.resolve('typescript/bin/tsc')
const fixtureConfig = path.join(packageRoot, 'test', 'fixtures', 'tsconfig.json')

describe('TypeScript consumer fixture', () => {
  it('strict tsc accepts public-api.d.ts against dist runtime', () => {
    const result = spawnSync(
      process.execPath,
      [tscPath, '-p', fixtureConfig, '--noEmit'],
      {
        cwd: packageRoot,
        encoding: 'utf8',
        env: process.env,
      },
    )

    assert.equal(
      result.status,
      0,
      `consumer fixture failed typecheck:\n${result.stdout}\n${result.stderr}`,
    )
  })
})

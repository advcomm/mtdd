const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

describe('proto-path from compiled dist', () => {
  it('getProtoPath() points at repo proto/mtdd.proto', () => {
    const { getProtoPath, getPackageRoot } = require('../src/proto-path')
    const protoPath = getProtoPath()
    const root = getPackageRoot()

    assert.match(protoPath, /proto[\\/]mtdd\.proto$/)
    assert.ok(fs.existsSync(protoPath), `proto missing at ${protoPath}`)
    assert.ok(
      fs.existsSync(path.join(root, 'package.json')),
      'package root should contain package.json',
    )
  })

  it('grpc-hub loadGrpcClient can load package definition', () => {
    const { getProtoPath } = require('../src/proto-path')
    const protoLoader = require('@grpc/proto-loader')
    const grpc = require('@grpc/grpc-js')

    const def = protoLoader.loadSync(getProtoPath(), {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    })

    const pkg = grpc.loadPackageDefinition(def).mtdd as {
      MtddShard?: unknown
      MtddNotify?: unknown
    }
    assert.ok(pkg.MtddShard, 'MtddShard service missing from proto')
    assert.ok(pkg.MtddNotify, 'MtddNotify service missing from proto')
  })
})

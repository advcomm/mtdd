/**
 * Compile-only fixture: TypeScript consumers importing public-api.d.ts
 * against the built CommonJS runtime.
 */
import type { MtddQueryConfig, MtddQueryRequest } from '../../src/public-api'
import type * as MtddApi from '../../src/public-api'

const mtdd = require('../../dist/src/index') as typeof MtddApi

const query: MtddQueryConfig = {
  text: 'SELECT 1',
  tid: 'tenant-a',
}

const req: MtddQueryRequest = {
  text: 'UPDATE items SET x = 1',
  commandType: 'UPDATE',
}

const classified = mtdd.classifyQuery('SELECT 1')
void classified.commandType

void mtdd.validateEnvDbHost
void mtdd.hooks.onQuery
void query.text
void req.tid

export type { MtddQueryConfig }

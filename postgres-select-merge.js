const { randomBytes } = require('node:crypto')
const { withLocalPostgresClient } = require('./postgres-local')
const {
  getUnnestMergeThreshold,
  getCopyMergeThreshold,
  getIndexMergeThreshold,
} = require('./local-merge-policy')
const {
  rewriteQueryTableNameAst,
  orderByColumnNames,
} = require('./select-order-rewrite')

const OID_TO_PG_TYPE = {
  16: 'boolean',
  17: 'bytea',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  700: 'real',
  701: 'double precision',
  1042: 'char',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
}

const INSERT_BATCH_SIZE = 500

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`
}

function pgTypeForField(field) {
  if (field?.dataTypeID && OID_TO_PG_TYPE[field.dataTypeID]) {
    return OID_TO_PG_TYPE[field.dataTypeID]
  }
  return 'text'
}

function pickFieldsFromShardResults(results) {
  for (const result of results) {
    if (result.fields && result.fields.length > 0) {
      return result.fields
    }
  }
  return []
}

function collectMergedRows(results) {
  const rows = []
  for (const result of results) {
    if (result.rows && result.rows.length > 0) {
      rows.push(...result.rows)
    }
  }
  return rows
}

function buildInsertPlaceholders(rowCount, columnCount, startParam = 1) {
  const groups = []
  let param = startParam
  for (let r = 0; r < rowCount; r++) {
    const placeholders = []
    for (let c = 0; c < columnCount; c++) {
      placeholders.push(`$${param}`)
      param++
    }
    groups.push(`(${placeholders.join(', ')})`)
  }
  return { sqlGroups: groups.join(', '), nextParam: param }
}

function formatCsvCell(value) {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'boolean') {
    return value ? 't' : 'f'
  }
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (typeof value === 'object') {
    const serialized = JSON.stringify(value)
    return `"${serialized.replace(/"/g, '""')}"`
  }
  const text = String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function buildCsvPayload(rows, fields) {
  const lines = []
  for (const row of rows) {
    lines.push(fields.map((field) => formatCsvCell(row[field.name])).join(','))
  }
  return `${lines.join('\n')}\n`
}

async function insertRowsBatched(client, tableName, fields, rows) {
  if (rows.length === 0) {
    return
  }

  const columnNames = fields.map((f) => quoteIdent(f.name))
  const columnList = columnNames.join(', ')

  for (let offset = 0; offset < rows.length; offset += INSERT_BATCH_SIZE) {
    const batch = rows.slice(offset, offset + INSERT_BATCH_SIZE)
    const { sqlGroups } = buildInsertPlaceholders(
      batch.length,
      fields.length,
      1,
    )
    const values = []
    for (const row of batch) {
      for (const field of fields) {
        values.push(row[field.name])
      }
    }
    await client.query(
      `INSERT INTO ${quoteIdent(tableName)} (${columnList}) VALUES ${sqlGroups}`,
      values,
    )
  }
}

async function insertRowsViaUnnest(client, tableName, fields, rows) {
  if (rows.length === 0) {
    return
  }

  const columnNames = fields.map((f) => quoteIdent(f.name))
  const params = []
  const unnestSelect = fields
    .map((field) => {
      const pgType = pgTypeForField(field)
      const values = rows.map((row) => row[field.name])
      params.push(values)
      return `unnest($${params.length}::${pgType}[])`
    })
    .join(', ')

  await client.query(
    `INSERT INTO ${quoteIdent(tableName)} (${columnNames.join(', ')})
     SELECT ${unnestSelect}`,
    params,
  )
}

async function insertRowsViaCopy(client, tableName, fields, rows) {
  if (rows.length === 0) {
    return
  }

  const { from: copyFrom } = require('pg-copy-streams')
  const columnList = fields.map((f) => quoteIdent(f.name)).join(', ')
  const copySql = `COPY ${quoteIdent(tableName)} (${columnList}) FROM STDIN WITH (FORMAT csv)`
  const stream = client.query(copyFrom(copySql))
  const payload = buildCsvPayload(rows, fields)

  await new Promise((resolve, reject) => {
    stream.on('error', reject)
    stream.on('finish', resolve)
    stream.end(payload)
  })
}

async function loadRowsIntoTempTable(client, tableName, fields, rows) {
  const rowCount = rows.length
  const copyThreshold = getCopyMergeThreshold()
  const unnestThreshold = getUnnestMergeThreshold()

  if (rowCount >= copyThreshold) {
    await insertRowsViaCopy(client, tableName, fields, rows)
    return 'copy'
  }

  if (rowCount >= unnestThreshold) {
    await insertRowsViaUnnest(client, tableName, fields, rows)
    return 'unnest'
  }

  await insertRowsBatched(client, tableName, fields, rows)
  return 'batch'
}

async function createOrderByIndex(client, tableName, orderBy, fields) {
  const columns = orderByColumnNames(orderBy)
  if (columns.length === 0) {
    return
  }

  const fieldSet = new Set(fields.map((field) => field.name))
  const indexColumns = columns.filter((column) => fieldSet.has(column))
  if (indexColumns.length === 0) {
    return
  }

  const indexList = indexColumns.map((column) => quoteIdent(column)).join(', ')
  await client.query(
    `CREATE INDEX ON ${quoteIdent(tableName)} (${indexList})`,
  )
}

async function mergeSelectResultsOnLocalPostgres(options) {
  const {
    credentials,
    tempTableName,
    fullText,
    shardResults,
    values,
    orderBy,
  } = options

  const fields = pickFieldsFromShardResults(shardResults)
  const rows = collectMergedRows(shardResults)

  if (fields.length === 0) {
    return {
      command: 'SELECT',
      rowCount: 0,
      oid: null,
      fields: [],
      rows: [],
    }
  }

  const sessionTable = `${tempTableName}_mtdd_${randomBytes(4).toString('hex')}`
  const columnDefs = fields
    .map((field) => `${quoteIdent(field.name)} ${pgTypeForField(field)}`)
    .join(', ')

  return withLocalPostgresClient(credentials, async (client) => {
    await client.query('BEGIN')
    try {
      await client.query(
        `CREATE TEMP TABLE ${quoteIdent(sessionTable)} (${columnDefs}) ON COMMIT DROP`,
      )

      const loadStrategy = await loadRowsIntoTempTable(
        client,
        sessionTable,
        fields,
        rows,
      )

      if (
        rows.length >= getIndexMergeThreshold() &&
        Array.isArray(orderBy) &&
        orderBy.length > 0
      ) {
        await createOrderByIndex(client, sessionTable, orderBy, fields)
      }

      const localSql = rewriteQueryTableNameAst(
        fullText,
        tempTableName,
        sessionTable,
      )
      const result = await client.query(localSql, values ?? [])

      await client.query('COMMIT')

      return {
        ...result,
        localMergeStrategy: 'postgres',
        localLoadStrategy: loadStrategy,
      }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // ignore rollback errors
      }
      throw err
    }
  })
}

function rewriteQueryTableName(sql, fromName, toName) {
  return rewriteQueryTableNameAst(sql, fromName, toName)
}

module.exports = {
  mergeSelectResultsOnLocalPostgres,
  quoteIdent,
  pgTypeForField,
  rewriteQueryTableName,
  rewriteQueryTableNameAst,
  pickFieldsFromShardResults,
  collectMergedRows,
  loadRowsIntoTempTable,
  insertRowsBatched,
  insertRowsViaUnnest,
  insertRowsViaCopy,
}

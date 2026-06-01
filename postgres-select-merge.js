const { randomBytes } = require('node:crypto')
const {
  buildLocalPostgresConfig,
  withLocalPostgresClient,
} = require('./postgres-local')

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

const INSERT_BATCH_SIZE = 500

async function insertRows(client, tableName, fields, rows) {
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

async function mergeSelectResultsOnLocalPostgres(options) {
  const {
    credentials,
    tempTableName,
    fullText,
    shardResults,
    values,
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

      await insertRows(client, sessionTable, fields, rows)

      const localSql = rewriteQueryTableName(fullText, tempTableName, sessionTable)
      const result = await client.query(localSql, values ?? [])

      await client.query('COMMIT')
      return result
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
  const escapedFrom = fromName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(
    `\\b(FROM|JOIN)\\s+(${escapedFrom})(?=\\s|$|,|\\)|;)`,
    'gi',
  )
  return sql.replace(pattern, (_match, keyword, table) => {
    return `${keyword} ${quoteIdent(toName)}`
  })
}

module.exports = {
  mergeSelectResultsOnLocalPostgres,
  quoteIdent,
  pgTypeForField,
  rewriteQueryTableName,
  pickFieldsFromShardResults,
  collectMergedRows,
}

const DEFAULT_UNNEST_THRESHOLD = 100
const DEFAULT_COPY_THRESHOLD = 1000
const DEFAULT_INDEX_THRESHOLD = 5000

function readPositiveInt(envName, defaultValue) {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') {
    return defaultValue
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `${envName} must be a non-negative number. Received: ${raw}`,
    )
  }
  return value
}

function getUnnestMergeThreshold() {
  return readPositiveInt(
    'MTDD_LOCAL_MERGE_UNNEST_THRESHOLD',
    DEFAULT_UNNEST_THRESHOLD,
  )
}

function getCopyMergeThreshold() {
  return readPositiveInt(
    'MTDD_LOCAL_MERGE_COPY_THRESHOLD',
    DEFAULT_COPY_THRESHOLD,
  )
}

function getIndexMergeThreshold() {
  return readPositiveInt(
    'MTDD_LOCAL_MERGE_INDEX_THRESHOLD',
    DEFAULT_INDEX_THRESHOLD,
  )
}

module.exports = {
  getUnnestMergeThreshold,
  getCopyMergeThreshold,
  getIndexMergeThreshold,
}

/**
 * PostgreSQL built-in aggregates for scatter-gather fan-out (PG docs §9.21).
 * Shards return row-level columns; the original SQL is re-run on merged rows.
 *
 * @see https://www.postgresql.org/docs/current/functions-aggregate.html
 */

/** Always rejected — wrong or undefined semantics across shards / merge load order. */
const REJECTED_FANOUT_AGGREGATES = new Set([
  'any_value',
  'rank',
  'dense_rank',
  'percent_rank',
  'cume_dist',
])

/**
 * Result order depends on input row order unless ORDER BY is specified in the
 * aggregate (PG docs). Merged temp-table row order is shard-defined, so require
 * an explicit per-aggregate ORDER BY.
 */
const ORDER_SENSITIVE_AGGREGATES = new Set([
  'array_agg',
  'string_agg',
  'xmlagg',
  'json_agg',
  'jsonb_agg',
  'json_agg_strict',
  'jsonb_agg_strict',
  'json_arrayagg',
  'json_object_agg',
  'jsonb_object_agg',
  'json_object_agg_strict',
  'jsonb_object_agg_strict',
  'json_object_agg_unique',
  'jsonb_object_agg_unique',
  'json_object_agg_unique_strict',
  'jsonb_object_agg_unique_strict',
])

/** Require WITHIN GROUP (ORDER BY …) on the aggregate call. */
const ORDERED_SET_AGGREGATES = new Set([
  'mode',
  'percentile_cont',
  'percentile_disc',
])

/** Safe associative / statistical aggregates (no extra ordering rules). */
const ASSOCIATIVE_AGGREGATES = new Set([
  'sum',
  'min',
  'max',
  'count',
  'avg',
  'stddev',
  'stddev_pop',
  'stddev_samp',
  'var',
  'var_pop',
  'var_samp',
  'variance',
  'bool_and',
  'bool_or',
  'every',
  'bit_and',
  'bit_or',
  'bit_xor',
  'corr',
  'covar_pop',
  'covar_samp',
  'regr_avgx',
  'regr_avgy',
  'regr_count',
  'regr_intercept',
  'regr_r2',
  'regr_slope',
  'regr_sxx',
  'regr_sxy',
  'regr_syy',
  'range_agg',
  'range_intersect_agg',
  'grouping',
])

const POSTGRES_SCATTER_GATHER_AGGREGATES = new Set([
  ...ASSOCIATIVE_AGGREGATES,
  ...ORDER_SENSITIVE_AGGREGATES,
  ...ORDERED_SET_AGGREGATES,
])

function aggregateFunctionName(callNode) {
  if (callNode?.type !== 'call' || !callNode.function?.name) {
    return null
  }
  return String(callNode.function.name).toLowerCase()
}

function isWindowCall(callNode) {
  return callNode?.type === 'call' && callNode.over != null
}

function isRejectedFanOutAggregate(callNode) {
  const name = aggregateFunctionName(callNode)
  return name !== null && REJECTED_FANOUT_AGGREGATES.has(name)
}

function hasAggregateOrderSpecification(callNode) {
  if (!callNode || callNode.type !== 'call') {
    return false
  }
  if (callNode.withinGroup != null) {
    return true
  }
  return Array.isArray(callNode.orderBy) && callNode.orderBy.length > 0
}

function isScatterGatherAggregate(callNode) {
  if (callNode?.type !== 'call' || isWindowCall(callNode)) {
    return false
  }
  const name = aggregateFunctionName(callNode)
  if (name === null) {
    return false
  }
  if (REJECTED_FANOUT_AGGREGATES.has(name)) {
    return false
  }
  if (POSTGRES_SCATTER_GATHER_AGGREGATES.has(name)) {
    return true
  }
  return callNode.withinGroup != null
}

function validateScatterGatherAggregateCall(callNode) {
  const name = aggregateFunctionName(callNode)
  if (name === null) {
    return
  }

  if (REJECTED_FANOUT_AGGREGATES.has(name)) {
    throw new Error(
      `aggregate function "${name}" is not supported for fan-out across shards`,
    )
  }

  if (ORDER_SENSITIVE_AGGREGATES.has(name) && !hasAggregateOrderSpecification(callNode)) {
    throw new Error(
      `aggregate function "${name}" requires ORDER BY within the aggregate for fan-out across shards`,
    )
  }

  if (ORDERED_SET_AGGREGATES.has(name) && callNode.withinGroup == null) {
    throw new Error(
      `aggregate function "${name}" requires WITHIN GROUP (ORDER BY ...) for fan-out across shards`,
    )
  }

  if (
    callNode.withinGroup != null &&
    !ORDERED_SET_AGGREGATES.has(name) &&
    !POSTGRES_SCATTER_GATHER_AGGREGATES.has(name)
  ) {
    throw new Error(
      `aggregate function "${name}" with WITHIN GROUP is not supported for fan-out across shards`,
    )
  }
}

/** @deprecated use POSTGRES_SCATTER_GATHER_AGGREGATES */
const SUPPORTED_AGGREGATE_FUNCTIONS = POSTGRES_SCATTER_GATHER_AGGREGATES

module.exports = {
  POSTGRES_SCATTER_GATHER_AGGREGATES,
  SUPPORTED_AGGREGATE_FUNCTIONS,
  REJECTED_FANOUT_AGGREGATES,
  ORDER_SENSITIVE_AGGREGATES,
  ORDERED_SET_AGGREGATES,
  ASSOCIATIVE_AGGREGATES,
  aggregateFunctionName,
  isWindowCall,
  isRejectedFanOutAggregate,
  isScatterGatherAggregate,
  hasAggregateOrderSpecification,
  validateScatterGatherAggregateCall,
}

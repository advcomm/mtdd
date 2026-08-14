## Purpose

Defines how MTDD obtains `tid` on the Postgres wire and how that tid is placed. Directory name is historical (`sp-first-param-tid`); this spec is **tid on the wire**, not stored-procedure-only and not “first bind parameter.”

Lookup (`mtdd_lookup`) remains the placement brain: opaque tid, SHA-256 prefix, binary-split `hostIndex = digest & (SHARD_COUNT - 1)` for `SHARD_COUNT = 2^k`.

## ADDED Requirements

### Requirement: SET mtdd.tid is the wire contract
For a statement to be routed, the client MUST first set tid with `SET mtdd.tid = '<string>'` (simple Query or equivalent). The proxy MUST treat that string as the opaque Lookup `tid` (no trim, case fold, or UUID validation). Placement MUST NOT read `query.tid`, AsyncLocalStorage, “first bind `$1`”, or SQL comments as the v1 contract.

#### Scenario: SET then SELECT
- **WHEN** the client sends `SET mtdd.tid = 'tenant-c'` and then `SELECT 1`
- **THEN** the proxy MUST use `tenant-c` as Lookup tid and MUST forward `SELECT 1` to exactly one shard

#### Scenario: JS tid is ignored
- **WHEN** a client process sets `tid` on a `pg` query config object but does not `SET mtdd.tid`
- **THEN** the proxy MUST reject the data statement (the JS property never appears on the wire)

#### Scenario: CALL is allowed but not required
- **WHEN** the client binds tid via SET and then `CALL some_proc($1, …)`
- **THEN** the proxy MUST route using the SET tid, not `$1`

### Requirement: Missing or empty tid is fail closed
The proxy MUST reject a data statement with no bound tid, or with NULL/empty tid. The client MUST receive a PostgreSQL error. The proxy MUST NOT call Lookup or open shard I/O for that statement.

#### Scenario: SELECT with no SET
- **WHEN** the client sends `SELECT 1` with no prior `SET mtdd.tid` on that unit of work
- **THEN** the proxy MUST return a Postgres error and MUST NOT contact Lookup or a shard

#### Scenario: Empty tid
- **WHEN** `SET mtdd.tid = ''`
- **THEN** the proxy MUST return a Postgres error and MUST NOT forward a following data statement

### Requirement: Lookup then one shard
Given a valid tid from SET, the proxy MUST `POST` Lookup `{ tid }` and MUST execute only on `hostIndex` in `[0, shardCount)`. The proxy MUST NOT fan the statement out to multiple shards.

#### Scenario: Golden binary-split vectors (N=2)
- **WHEN** Lookup `SHARD_COUNT` is 2 and the client binds `tenant-c` then a write/read, and separately `tenant-a` then a write/read
- **THEN** `tenant-c` MUST execute only on hostIndex `0` and `tenant-a` only on hostIndex `1` (Lookup golden table)

#### Scenario: Two tids two shards
- **WHEN** two statements have tids that Lookup maps to different `hostIndex` values
- **THEN** each statement MUST execute only on its mapped shard

### Requirement: No tid-null fan-out
The system MUST NOT support `tid: null` broadcast or SELECT merge. Work that needs every shard MUST be issued per shard with an explicit tid (or out-of-band jobs), not as a proxy feature in this change.

#### Scenario: No broadcast
- **WHEN** a client issues a statement intending “all shards”
- **THEN** the proxy MUST NOT run it on every backend; without a valid SET tid it MUST error

### Requirement: Tid scope does not leak across pool reuse
A bound tid MUST NOT remain in effect for the lifetime of an application-side pooled connection after the unit of work ends. Autocommit: tid applies to the next data statement (or the statements in the same simple-Query batch after SET). In a transaction: tid pins the session to that hostIndex until COMMIT/ROLLBACK; a different tid in the same transaction MUST error if it maps to another shard.

#### Scenario: Second autocommit query without SET
- **WHEN** a client runs SET+SELECT successfully, then on the same connection runs SELECT without SET
- **THEN** the second SELECT MUST be rejected

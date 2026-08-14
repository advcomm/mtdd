## Purpose

Defines the out-of-process Postgres routing proxy: the process that performs MTDD’s operations (bind tid, lookup, execute on one shard, return native results) behind HAProxy. It is a routing proxy, not a dumb TCP splice and not an SQL engine. HAProxy-to-HAProxy is the PoC transport; a later QUIC client/agent MUST preserve these requirements.

## ADDED Requirements

### Requirement: Vanilla client path
Applications MUST connect with an unmodified Postgres client (including `pg` Pool/Client) to the HAProxy VIP that fronts the MTDD proxy. The system MUST NOT require `--require @advcomm/mtdd/register` or any in-process driver patch for routing.

#### Scenario: App starts without register
- **WHEN** a process starts without `@advcomm/mtdd/register` and opens a PG connection to the published VIP
- **THEN** the connection succeeds and the client can issue statements the proxy accepts or rejects per other requirements

#### Scenario: Register is not the production entry
- **WHEN** a consumer looks up the supported integration
- **THEN** documentation and package exports MUST present VIP + vanilla PG + wire tid, and MUST NOT present `./register` or gRPC QueryStream as the supported production entry

### Requirement: Same-socket native results
The proxy MUST speak the PostgreSQL wire protocol to the client. Results MUST return on the same TCP connection the client opened, as native Postgres messages.

#### Scenario: Statement result is native Postgres
- **WHEN** a vanilla client issues a statement the proxy forwards and the shard returns rows or an error
- **THEN** the client library receives a normal PG result or error without an MTDD preload in the process

### Requirement: HAProxy is TCP only
HAProxy in front of the proxy and in front of each shard Postgres MUST remain a TCP VIP with optional PostgreSQL health checks. HAProxy MUST NOT be required to parse SQL, bind params, or tid.

#### Scenario: HAProxy session log has no SQL
- **WHEN** a statement is sent through the gateway HAProxy
- **THEN** HAProxy MAY log session metadata and MUST NOT be relied on to log query text, bind params, or tid

### Requirement: Backend connection reuse
The proxy MUST maintain a pool of backend connections to each shard HAProxy VIP. Executing a statement MUST use an existing idle backend connection when the pool has one. The system MUST NOT establish a new TLS session (or, when TLS is off, a new TCP + Postgres startup) to the shard HAP for every query.

#### Scenario: Two queries one shard one backend handshake
- **WHEN** a client issues two successive statements whose tid maps to the same `hostIndex` and an idle pooled backend exists
- **THEN** the second statement MUST NOT create a new TLS session (or equivalent new backend PG startup) to that shard HAP

#### Scenario: Pool per shard
- **WHEN** tids map to different `hostIndex` values
- **THEN** the proxy MAY use different backend pools and MUST still reuse connections within each pool

### Requirement: Forward opaque SQL
After a valid tid is bound, the proxy MUST forward the client’s statement to the chosen shard without requiring it to be `CALL`. SELECT, INSERT, UPDATE, DELETE, and CALL are all in scope for v1 as long as they are not rejected for other protocol reasons (COPY, named prepared statements may still be out of v1).

#### Scenario: SELECT after tid is forwarded
- **WHEN** the client has bound a valid tid and sends `SELECT 1`
- **THEN** the proxy MUST Lookup, forward to one shard, and return the native result (not a “non-CALL” error)

#### Scenario: Missing tid is still rejected
- **WHEN** the client sends `SELECT 1` with no tid bound
- **THEN** the proxy MUST return a Postgres error and MUST NOT forward to a shard

### Requirement: Transport evolution does not change operations
A future Rust QUIC client/agent MUST perform the same operations (bind tid, lookup or equivalent placement, execute, native result, long-lived session). This PoC MUST NOT introduce gRPC as a required hop.

#### Scenario: No gRPC on the app path
- **WHEN** the PoC path is used
- **THEN** the application MUST NOT need a gRPC client or `mtdd_server` QueryStream to run a routed statement

# Changelog

## Unreleased

### Added

- gRPC TLS via `MTDD_GRPC_TLS_*` / `MTDD_NOTIFY_TLS_*` environment variables
- `shutdownMtdd()` and `MTDD_AUTO_SHUTDOWN=1` for graceful teardown
- LISTEN/NOTIFY cleanup on checked-out `client.release()`
- MtddNotify `Watch` reconnect with re-subscribe (`MTDD_NOTIFY_WATCH_RECONNECT_MS`)
- Lookup cache (`MTDD_LOOKUP_CACHE_TTL_MS`), gRPC retries (`MTDD_GRPC_MAX_RETRIES`), lookup retries
- Fan-out policy `MTDD_FANOUT_POLICY=all|best_effort`
- Per-query OpenTelemetry spans when `@opentelemetry/api` is installed
- Plain SQL only: reject prepared statements (`query` config `name`)
- GitHub Actions CI and `scripts/sync-proto.sh`

### Changed

- `register.js` installs patch and registers shutdown hooks on preload

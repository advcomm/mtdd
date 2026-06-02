#!/usr/bin/env bash
set -euo pipefail

REF="${MTDD_PROTO_REF:-04d16b5ecdee89dc98184b4c276f9a9b5ef7d8e5}"
REPO="${MTDD_PROTO_REPO:-https://github.com/advcomm/mtdd_server.git}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/proto/mtdd.proto"
TMP="$(mktemp -d)"

trap 'rm -rf "$TMP"' EXIT

git clone --depth 1 --branch "$REF" "$REPO" "$TMP/repo"
cp "$TMP/repo/proto/mtdd.proto" "$DEST"
echo "Synced proto from $REPO@$REF to $DEST"

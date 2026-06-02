function emptyPgResult(command) {
  return {
    command,
    rowCount: 0,
    oid: null,
    fields: [],
    rows: [],
  }
}

function syntheticListenResult() {
  return emptyPgResult('LISTEN')
}

function syntheticUnlistenResult() {
  return emptyPgResult('UNLISTEN')
}

function syntheticNotifyResult() {
  return emptyPgResult('NOTIFY')
}

module.exports = {
  syntheticListenResult,
  syntheticUnlistenResult,
  syntheticNotifyResult,
}

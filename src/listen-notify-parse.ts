/**
 * Pre-parse LISTEN / UNLISTEN / NOTIFY (pgsql-ast-parser does not model these).
 */

const LISTEN_PATTERN =
  /^\s*LISTEN\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z_][a-zA-Z0-9_$]*))\s*;?\s*$/i

const UNLISTEN_STAR_PATTERN = /^\s*UNLISTEN\s+\*\s*;?\s*$/i

const UNLISTEN_PATTERN =
  /^\s*UNLISTEN\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z_][a-zA-Z0-9_$]*))\s*;?\s*$/i

const NOTIFY_PATTERN =
  /^\s*NOTIFY\s+(?:"([^"]+)"|'([^']+)'|([a-zA-Z_][a-zA-Z0-9_$]*))(?:\s*,\s*(.+))?\s*;?\s*$/is

function pickChannel(groups) {
  return groups[0] ?? groups[1] ?? groups[2] ?? null
}

function parseNotifyPayload(raw) {
  if (raw === undefined || raw === null) {
    return ''
  }
  const trimmed = String(raw).trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseListenNotifyStatement(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return null
  }

  const sql = text.trim()

  if (UNLISTEN_STAR_PATTERN.test(sql)) {
    return {
      commandType: 'UNLISTEN',
      unlistenAll: true,
      channel: null,
    }
  }

  const listenMatch = sql.match(LISTEN_PATTERN)
  if (listenMatch) {
    const channel = pickChannel(listenMatch.slice(1))
    if (!channel) {
      return null
    }
    return {
      commandType: 'LISTEN',
      channel,
      unlistenAll: false,
    }
  }

  const unlistenMatch = sql.match(UNLISTEN_PATTERN)
  if (unlistenMatch) {
    const channel = pickChannel(unlistenMatch.slice(1))
    if (!channel) {
      return null
    }
    return {
      commandType: 'UNLISTEN',
      channel,
      unlistenAll: false,
    }
  }

  const notifyMatch = sql.match(NOTIFY_PATTERN)
  if (notifyMatch) {
    const channel = pickChannel(notifyMatch.slice(1, 4))
    if (!channel) {
      return null
    }
    return {
      commandType: 'NOTIFY',
      channel,
      payload: parseNotifyPayload(notifyMatch[4]),
      unlistenAll: false,
    }
  }

  return null
}

function isListenNotifyCommandType(commandType) {
  return commandType === 'LISTEN' || commandType === 'UNLISTEN' || commandType === 'NOTIFY'
}

module.exports = {
  parseListenNotifyStatement,
  isListenNotifyCommandType,
}

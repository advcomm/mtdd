const net = require('node:net')

function validateEnvDbHost() {
  const raw = process.env.DB_HOST

  if (raw === undefined || raw === '') {
    throw new Error(
      'DB_HOST is required when @advcomm/mtdd is loaded. Set DB_HOST to a JSON array of IP addresses, e.g. ["10.0.1.10","10.0.1.11"].',
    )
  }

  let parsed
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    throw new Error(
      `DB_HOST must be valid JSON parsing to a non-empty array of IP addresses. Received: ${raw}`,
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `DB_HOST must be a JSON array of IP addresses, not a single value. Received: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`,
    )
  }

  if (parsed.length === 0) {
    throw new Error('DB_HOST array must not be empty.')
  }

  for (let i = 0; i < parsed.length; i++) {
    const item = parsed[i]
    if (typeof item !== 'string') {
      throw new Error(
        `DB_HOST[${i}] must be a string IP address. Received: ${JSON.stringify(item)}`,
      )
    }
    if (net.isIP(item) === 0) {
      throw new Error(
        `DB_HOST[${i}] must be an IPv4 or IPv6 address; hostnames are not allowed. Received: ${item}`,
      )
    }
  }

  return parsed
}

module.exports = {
  validateEnvDbHost,
}

let nextCounter = 0

function selectHost(hosts) {
  const index = nextCounter++ % hosts.length
  return hosts[index]
}

function resetHostCounter() {
  nextCounter = 0
}

module.exports = {
  selectHost,
  resetHostCounter,
}

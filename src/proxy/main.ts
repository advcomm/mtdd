#!/usr/bin/env node
const { loadProxyConfigFromEnv } = require("./config");
const { createProxy } = require("./server");

async function main() {
	const config = loadProxyConfigFromEnv();
	const proxy = createProxy(config);
	const addr = await proxy.listen();
	console.log(
		`mtdd-proxy pg ${config.listenHost}:${addr.pg.port} health ${config.listenHost}:${addr.health.port} shards=${config.shards.length}`,
	);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

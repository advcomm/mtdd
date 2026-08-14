const net = require("node:net");
const http = require("node:http");
const { ProxySession } = require("./session");
const { BackendPools } = require("./backend-pool");

function createProxy(config) {
	const pools = new BackendPools(config.shards, {
		user: config.user,
		password: config.password,
		poolMax: config.poolMax,
	});

	const pgServer = net.createServer((socket) => {
		const session = new ProxySession(socket, { config, pools });
		session.start();
	});

	const health = http.createServer((req, res) => {
		if (req.url === "/health" || req.url === "/") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					ok: true,
					shards: config.shards.length,
					metrics: pools.metrics(),
				}),
			);
			return;
		}
		res.writeHead(404);
		res.end();
	});

	return {
		pools,
		listen() {
			return new Promise((resolve, reject) => {
				pgServer.once("error", reject);
				pgServer.listen(config.listenPort, config.listenHost, () => {
					health.listen(config.healthPort, config.listenHost, () => {
						resolve({
							pg: pgServer.address(),
							health: health.address(),
						});
					});
				});
			});
		},
		async close() {
			await new Promise((r) => health.close(r));
			await new Promise((r) => pgServer.close(r));
			await pools.end();
		},
	};
}

module.exports = { createProxy };

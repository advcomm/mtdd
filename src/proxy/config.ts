function parseShardHosts(raw: string) {
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(
			`MTDD_SHARD_HOSTS must be JSON. Received: ${raw.slice(0, 120)}`,
		);
	}
	if (!Array.isArray(parsed) || parsed.length < 2) {
		throw new Error("MTDD_SHARD_HOSTS must be a JSON array with at least 2 shards");
	}
	return parsed.map((item, i) => {
		if (typeof item === "string") {
			const m = item.match(
				/^(?<host>[^:/]+)(?::(?<port>\d+))?(?:\/(?<database>.+))?$/,
			);
			if (!m || !m.groups) {
				throw new Error(`MTDD_SHARD_HOSTS[${i}] invalid: ${item}`);
			}
			return {
				host: m.groups.host,
				port: Number(m.groups.port || process.env.DB_PORT || 5432),
				database: m.groups.database || process.env.DB_NAME || "postgres",
			};
		}
		if (item && typeof item === "object" && item.host) {
			return {
				host: String(item.host),
				port: Number(item.port || process.env.DB_PORT || 5432),
				database: String(item.database || process.env.DB_NAME || "postgres"),
			};
		}
		throw new Error(
			`MTDD_SHARD_HOSTS[${i}] must be host:port/db or {host,port,database}`,
		);
	});
}

function defaultShardHostsJson() {
	return JSON.stringify([
		{
			host: process.env.MTDD_SHARD0_HOST || "127.0.0.1",
			port: Number(process.env.MTDD_SHARD0_PORT || 5432),
			database: process.env.MTDD_SHARD0_DATABASE || "mtdd_shard_0",
		},
		{
			host: process.env.MTDD_SHARD1_HOST || "127.0.0.1",
			port: Number(process.env.MTDD_SHARD1_PORT || 5432),
			database: process.env.MTDD_SHARD1_DATABASE || "mtdd_shard_1",
		},
	]);
}

function loadProxyConfigFromEnv() {
	const lookupUrl = process.env.MTDD_LOOKUP_URL;
	if (!lookupUrl) {
		throw new Error("MTDD_LOOKUP_URL is required for mtdd-proxy");
	}
	const shards = parseShardHosts(
		process.env.MTDD_SHARD_HOSTS || defaultShardHostsJson(),
	);
	return {
		listenHost: process.env.MTDD_PROXY_BIND || "127.0.0.1",
		listenPort: Number(process.env.MTDD_PROXY_PORT || 6432),
		healthPort: Number(process.env.MTDD_PROXY_HEALTH_PORT || 6433),
		lookupUrl,
		user: process.env.DB_USER || "postgres",
		password: process.env.DB_PASSWORD ?? "",
		database: process.env.DB_NAME || "postgres",
		shards,
		poolMax: Number(process.env.MTDD_PROXY_POOL_MAX || 8),
	};
}

module.exports = {
	parseShardHosts,
	loadProxyConfigFromEnv,
};

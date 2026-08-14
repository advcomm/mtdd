// @ts-nocheck
const { Pool } = require("pg");

class BackendPools {
	constructor(shards, { user, password, poolMax }) {
		this.shards = shards;
		this.backendConnects = shards.map(() => 0);
		this.backendQueries = shards.map(() => 0);
		this.pools = shards.map((shard, i) => {
			const pool = new Pool({
				host: shard.host,
				port: shard.port,
				database: shard.database,
				user,
				password,
				max: poolMax || 8,
			});
			pool.on("connect", () => {
				this.backendConnects[i] += 1;
			});
			return pool;
		});
	}

	metrics() {
		return {
			backendConnects: this.backendConnects.slice(),
			backendQueries: this.backendQueries.slice(),
		};
	}

	async query(hostIndex, text, values) {
		this.backendQueries[hostIndex] += 1;
		return this.pools[hostIndex].query(text, values);
	}

	async connect(hostIndex) {
		return this.pools[hostIndex].connect();
	}

	noteQuery(hostIndex) {
		this.backendQueries[hostIndex] += 1;
	}

	async end() {
		await Promise.all(this.pools.map((p) => p.end().catch(() => {})));
	}
}

module.exports = { BackendPools };

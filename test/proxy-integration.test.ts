const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { createMockLookupServer } = require("./helpers");
const { createProxy } = require("../src/proxy/server");

const GOLDENS = { "tenant-c": 0, "tenant-a": 1 };

function adminConfig() {
	return {
		host: process.env.MTDD_TEST_PG_HOST || "127.0.0.1",
		port: Number(process.env.MTDD_TEST_PG_PORT || process.env.DB_PORT || 5432),
		user: process.env.DB_USER || "postgres",
		password: process.env.DB_PASSWORD ?? "root",
		database: "postgres",
	};
}

async function tryConnect() {
	const client = new Client(adminConfig());
	try {
		await client.connect();
		await client.query("SELECT 1");
		return client;
	} catch {
		await client.end().catch(() => {});
		return null;
	}
}

async function ensureDb(admin, name) {
	const found = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
		name,
	]);
	if (found.rowCount === 0) {
		await admin.query(`CREATE DATABASE ${name}`);
	}
}

async function shardClient(name) {
	const cfg = adminConfig();
	const client = new Client({ ...cfg, database: name });
	await client.connect();
	return client;
}

describe("mtdd-proxy integration", () => {
	let skip = false;
	let lookup;
	let proxy;
	let pgPort;
	let admin;
	const db0 = "mtdd_shard_0";
	const db1 = "mtdd_shard_1";

	before(async () => {
		admin = await tryConnect();
		if (!admin) {
			skip = true;
			console.log("skip proxy integration: local Postgres not reachable");
			return;
		}
		await ensureDb(admin, db0);
		await ensureDb(admin, db1);
		for (const name of [db0, db1]) {
			const c = await shardClient(name);
			await c.query("DROP TABLE IF EXISTS mtdd_probe");
			await c.query(
				"CREATE TABLE mtdd_probe (tid text PRIMARY KEY, v int)",
			);
			await c.end();
		}
		lookup = await createMockLookupServer((body) => {
			const hostIndex = GOLDENS[body.tid];
			if (hostIndex === undefined) return { hostIndex: 0 };
			return { hostIndex };
		});
		const cfg = adminConfig();
		proxy = createProxy({
			listenHost: "127.0.0.1",
			listenPort: 0,
			healthPort: 0,
			lookupUrl: lookup.url,
			user: cfg.user,
			password: cfg.password,
			shards: [
				{ host: cfg.host, port: cfg.port, database: db0 },
				{ host: cfg.host, port: cfg.port, database: db1 },
			],
			poolMax: 2,
		});
		const addr = await proxy.listen();
		pgPort = addr.pg.port;
	});

	after(async () => {
		if (proxy) await proxy.close();
		if (lookup) await lookup.close();
		if (admin) await admin.end().catch(() => {});
	});

	it("SET + write/read follows Lookup goldens (tenant-c=0, tenant-a=1)", async () => {
		if (skip) return;
		const cfg = adminConfig();
		const client = new Client({
			host: "127.0.0.1",
			port: pgPort,
			user: cfg.user,
			password: cfg.password,
			database: "postgres",
		});
		await client.connect();
		await client.query("SET mtdd.tid = 'tenant-c'");
		await client.query("INSERT INTO mtdd_probe(tid, v) VALUES ('tenant-c', 1)");
		await client.query("SET mtdd.tid = 'tenant-a'");
		await client.query("INSERT INTO mtdd_probe(tid, v) VALUES ('tenant-a', 1)");
		await client.end();

		const s0 = await shardClient(db0);
		const s1 = await shardClient(db1);
		const r0 = await s0.query("SELECT tid FROM mtdd_probe ORDER BY tid");
		const r1 = await s1.query("SELECT tid FROM mtdd_probe ORDER BY tid");
		await s0.end();
		await s1.end();
		assert.deepEqual(
			r0.rows.map((r) => r.tid),
			["tenant-c"],
		);
		assert.deepEqual(
			r1.rows.map((r) => r.tid),
			["tenant-a"],
		);
	});

	it("parameterized SELECT through extended protocol returns the bound value", async () => {
		if (skip) return;
		const cfg = adminConfig();
		const client = new Client({
			host: "127.0.0.1",
			port: pgPort,
			user: cfg.user,
			password: cfg.password,
		});
		await client.connect();
		await client.query("SET mtdd.tid = 'tenant-c'");
		const result = await client.query("SELECT $1::int AS n", [7]);
		await client.end();
		assert.equal(Number(result.rows[0]?.n), 7);
	});

	it("SELECT 1 without SET is a Postgres error and does not hit a shard", async () => {
		if (skip) return;
		const before = proxy.pools.metrics().backendQueries.slice();
		const cfg = adminConfig();
		const client = new Client({
			host: "127.0.0.1",
			port: pgPort,
			user: cfg.user,
			password: cfg.password,
		});
		await client.connect();
		await assert.rejects(
			() => client.query("SELECT 1"),
			/mtdd\.tid is not set/i,
		);
		await client.end();
		assert.deepEqual(proxy.pools.metrics().backendQueries, before);
	});

	it("autocommit tid does not leak to the next query", async () => {
		if (skip) return;
		const cfg = adminConfig();
		const client = new Client({
			host: "127.0.0.1",
			port: pgPort,
			user: cfg.user,
			password: cfg.password,
		});
		await client.connect();
		await client.query("SET mtdd.tid = 'tenant-c'");
		await client.query("SELECT 1 AS n");
		await assert.rejects(
			() => client.query("SELECT 1 AS n"),
			/mtdd\.tid is not set/i,
		);
		await client.end();
	});

	it("two statements to the same shard reuse a backend connection", async () => {
		if (skip) return;
		const before = proxy.pools.metrics();
		const cfg = adminConfig();
		const client = new Client({
			host: "127.0.0.1",
			port: pgPort,
			user: cfg.user,
			password: cfg.password,
		});
		await client.connect();
		await client.query("SET mtdd.tid = 'tenant-c'");
		await client.query("SELECT 1 AS n");
		await client.query("SET mtdd.tid = 'tenant-c'");
		await client.query("SELECT 1 AS n");
		await client.end();
		const after = proxy.pools.metrics();
		const queries = after.backendQueries[0] - before.backendQueries[0];
		const connects = after.backendConnects[0] - before.backendConnects[0];
		assert.ok(queries >= 2, `expected >=2 shard queries, got ${queries}`);
		assert.ok(
			connects < queries,
			`expected connection reuse (connects ${connects} < queries ${queries})`,
		);
	});
});

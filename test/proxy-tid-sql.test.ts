const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { splitStatements, classifyStatement } = require("../src/proxy/tid-sql");
const { parseShardHosts } = require("../src/proxy/config");
const { lookupHostIndex } = require("../src/proxy/lookup");
const { createMockLookupServer } = require("./helpers");

describe("tid SQL", () => {
	it("extracts SET mtdd.tid", () => {
		const k = classifyStatement("SET mtdd.tid = 'tenant-c'");
		assert.deepEqual(k, { kind: "set_tid", tid: "tenant-c" });
	});

	it("rejects empty tid at classify as empty string", () => {
		const k = classifyStatement("SET mtdd.tid = ''");
		assert.equal(k.kind, "set_tid");
		assert.equal(k.tid, "");
	});

	it("splits SET then SELECT", () => {
		assert.deepEqual(splitStatements("SET mtdd.tid = 'tenant-a'; SELECT 1"), [
			"SET mtdd.tid = 'tenant-a'",
			"SELECT 1",
		]);
	});

	it("classifies begin/commit/data", () => {
		assert.equal(classifyStatement("BEGIN").kind, "begin");
		assert.equal(classifyStatement("COMMIT").kind, "commit");
		assert.equal(classifyStatement("SELECT 1").kind, "data");
		assert.equal(classifyStatement("RESET mtdd.tid").kind, "reset_tid");
	});
});

describe("lookup hostIndex bounds", () => {
	it("returns golden vectors and rejects out of range", async () => {
		const lookup = await createMockLookupServer((body) => {
			if (body.tid === "tenant-c") return { hostIndex: 0 };
			if (body.tid === "tenant-a") return { hostIndex: 1 };
			if (body.tid === "bad") return { hostIndex: 9 };
			return { hostIndex: 0 };
		});
		try {
			assert.equal(await lookupHostIndex(lookup.url, "tenant-c", 2), 0);
			assert.equal(await lookupHostIndex(lookup.url, "tenant-a", 2), 1);
			await assert.rejects(
				() => lookupHostIndex(lookup.url, "bad", 2),
				/out of range/,
			);
		} finally {
			await lookup.close();
		}
	});
});

describe("parseShardHosts", () => {
	it("parses host:port/database objects", () => {
		const shards = parseShardHosts(
			JSON.stringify([
				{ host: "127.0.0.1", port: 15442, database: "mtdd_shard_0" },
				{ host: "127.0.0.1", port: 15443, database: "mtdd_shard_1" },
			]),
		);
		assert.equal(shards.length, 2);
		assert.equal(shards[0].database, "mtdd_shard_0");
	});
});

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { runRegister } = require("./helpers");

describe("register preload is fail-closed", () => {
	it("throws migration text even with a valid DB_HOST array", () => {
		const result = runRegister({
			DB_HOST: '["10.0.1.10","10.0.1.11"]',
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /register is no longer supported/i);
		assert.match(result.stderr, /SET mtdd\.tid/i);
	});

	it("throws the same text when DB_HOST is missing", () => {
		const result = runRegister({ DB_HOST: undefined });
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /register is no longer supported/i);
	});
});

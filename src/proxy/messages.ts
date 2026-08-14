const REGISTER_REMOVED = [
	"@advcomm/mtdd/register is no longer supported.",
	"Point a vanilla pg client at the HAProxy gateway VIP (DB_HOST / DB_PORT as a single host).",
	"Issue SET mtdd.tid = '<tid>' before each statement (or at the start of a transaction).",
	"Run the routing proxy: npm run mtdd-proxy",
	"See README.md (tool operations: bind tid → lookup → execute → native result → reuse).",
].join("\n");

module.exports = { REGISTER_REMOVED };

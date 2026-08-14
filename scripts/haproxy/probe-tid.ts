/**
 * Vanilla pg probe: SET mtdd.tid + SQL through the GW VIP (or proxy port).
 * No --require @advcomm/mtdd/register.
 */
const { Client } = require("pg");

const host = process.env.PGHOST || process.env.DB_HOST || "127.0.0.1";
const port = Number(process.env.PGPORT || process.env.DB_PORT || 15432);
const user = process.env.PGUSER || process.env.DB_USER || "postgres";
const password = process.env.PGPASSWORD ?? process.env.DB_PASSWORD ?? "";
const database = process.env.PGDATABASE || process.env.DB_NAME || "postgres";

async function main() {
	const client = new Client({ host, port, user, password, database });
	await client.connect();
	await client.query("SET mtdd.tid = 'tenant-c'");
	const result = await client.query("SELECT 1 AS n");
	if (result.rows[0]?.n !== 1 && result.rows[0]?.n !== "1") {
		throw new Error(`unexpected result: ${JSON.stringify(result.rows)}`);
	}
	console.log(
		JSON.stringify({ ok: true, host, port, rows: result.rows }, null, 2),
	);
	await client.end();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});

/**
 * Classify / split SQL for the routing proxy.
 * SET mtdd.tid is intercepted; everything else is opaque to Postgres.
 */

function splitStatements(sql: string): string[] {
	const out: string[] = [];
	let buf = "";
	let i = 0;
	let quote: "'" | '"' | null = null;
	let dollar: string | null = null;

	while (i < sql.length) {
		const c = sql[i];
		if (dollar) {
			if (sql.startsWith(dollar, i)) {
				buf += dollar;
				i += dollar.length;
				dollar = null;
				continue;
			}
			buf += c;
			i += 1;
			continue;
		}
		if (quote) {
			buf += c;
			if (c === quote) {
				if (quote === "'" && sql[i + 1] === "'") {
					buf += "'";
					i += 2;
					continue;
				}
				quote = null;
			}
			i += 1;
			continue;
		}
		if (c === "$" && sql[i + 1] === "$") {
			const m = sql.slice(i).match(/^\$[A-Za-z0-9_]*\$/);
			if (m) {
				dollar = m[0];
				buf += dollar;
				i += dollar.length;
				continue;
			}
		}
		if (c === "'" || c === '"') {
			quote = c;
			buf += c;
			i += 1;
			continue;
		}
		if (c === "-" && sql[i + 1] === "-") {
			const nl = sql.indexOf("\n", i);
			i = nl === -1 ? sql.length : nl + 1;
			continue;
		}
		if (c === "/" && sql[i + 1] === "*") {
			const end = sql.indexOf("*/", i + 2);
			i = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (c === ";") {
			const piece = buf.trim();
			if (piece) out.push(piece);
			buf = "";
			i += 1;
			continue;
		}
		buf += c;
		i += 1;
	}
	const last = buf.trim();
	if (last) out.push(last);
	return out;
}

const SET_TID =
	/^\s*SET\s+mtdd\.tid\s*(?:=|TO)\s*(?:'((?:\\'|[^'])*)'|"((?:\\"|[^"])*)"|(\S+))\s*$/i;
const RESET_TID = /^\s*RESET\s+mtdd\.tid\s*$/i;
const BEGIN_RE = /^\s*(BEGIN|START\s+TRANSACTION)(\s+.*)?$/i;
const COMMIT_RE = /^\s*COMMIT(\s+TRANSACTION)?\s*$/i;
const ROLLBACK_RE = /^\s*ROLLBACK(\s+TRANSACTION)?(\s+TO\s+SAVEPOINT\s+\S+)?\s*$/i;

function unquote(raw: string) {
	return raw.replace(/\\'/g, "'").replace(/''/g, "'").replace(/\\"/g, '"');
}

function classifyStatement(sql: string) {
	const text = sql.trim();
	if (!text) return { kind: "data", sql: text };
	const set = text.match(SET_TID);
	if (set) {
		const raw = set[1] ?? set[2] ?? set[3] ?? "";
		return { kind: "set_tid", tid: unquote(raw) };
	}
	if (RESET_TID.test(text)) return { kind: "reset_tid" };
	if (BEGIN_RE.test(text)) return { kind: "begin" };
	if (COMMIT_RE.test(text)) return { kind: "commit" };
	if (ROLLBACK_RE.test(text)) return { kind: "rollback" };
	return { kind: "data", sql: text };
}

module.exports = {
	splitStatements,
	classifyStatement,
};

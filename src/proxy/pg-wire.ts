const SSL_REQUEST = 80877103;
const PROTOCOL_3 = 196608;

function readCString(buf: Buffer, offset: number): { value: string; next: number } {
	const end = buf.indexOf(0, offset);
	if (end === -1) throw new Error("unterminated cstring");
	return { value: buf.toString("utf8", offset, end), next: end + 1 };
}

function encodeMessage(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
	const header = Buffer.alloc(5);
	header[0] = type.charCodeAt(0);
	header.writeInt32BE(4 + payload.length, 1);
	return Buffer.concat([header, payload]);
}

function readyForQuery(status: "I" | "T" | "E" = "I"): Buffer {
	return encodeMessage("Z", Buffer.from(status, "ascii"));
}

function authenticationOk(): Buffer {
	const p = Buffer.alloc(4);
	p.writeInt32BE(0, 0);
	return encodeMessage("R", p);
}

function authenticationCleartext(): Buffer {
	const p = Buffer.alloc(4);
	p.writeInt32BE(3, 0);
	return encodeMessage("R", p);
}

function parameterStatus(name: string, value: string): Buffer {
	return encodeMessage(
		"S",
		Buffer.concat([Buffer.from(`${name}\0${value}\0`, "utf8")]),
	);
}

function backendKeyData(pid: number, secret: number): Buffer {
	const p = Buffer.alloc(8);
	p.writeInt32BE(pid, 0);
	p.writeInt32BE(secret, 4);
	return encodeMessage("K", p);
}

function commandComplete(tag: string): Buffer {
	return encodeMessage("C", Buffer.from(`${tag}\0`, "utf8"));
}

function parseComplete(): Buffer {
	return encodeMessage("1");
}

function bindComplete(): Buffer {
	return encodeMessage("2");
}

function noData(): Buffer {
	return encodeMessage("n");
}

function errorResponse(message: string, code = "P0001"): Buffer {
	const fields = Buffer.concat([
		Buffer.from("SERROR\0", "utf8"),
		Buffer.from(`C${code}\0`, "utf8"),
		Buffer.from(`M${message}\0`, "utf8"),
		Buffer.from([0]),
	]);
	return encodeMessage("E", fields);
}

function rowDescription(
	fields: Array<{ name: string; dataTypeID: number }>,
): Buffer {
	const parts: Buffer[] = [];
	const count = Buffer.alloc(2);
	count.writeInt16BE(fields.length, 0);
	parts.push(count);
	for (const f of fields) {
		const name = Buffer.from(`${f.name}\0`, "utf8");
		const rest = Buffer.alloc(18);
		rest.writeInt32BE(0, 0);
		rest.writeInt16BE(0, 4);
		rest.writeInt32BE(f.dataTypeID || 25, 6);
		rest.writeInt16BE(-1, 10);
		rest.writeInt32BE(-1, 12);
		rest.writeInt16BE(0, 16);
		parts.push(name, rest);
	}
	return encodeMessage("T", Buffer.concat(parts));
}

function dataRow(values: unknown[]): Buffer {
	const parts: Buffer[] = [];
	const count = Buffer.alloc(2);
	count.writeInt16BE(values.length, 0);
	parts.push(count);
	for (const v of values) {
		if (v === null || v === undefined) {
			const n = Buffer.alloc(4);
			n.writeInt32BE(-1, 0);
			parts.push(n);
			continue;
		}
		const text = Buffer.from(String(v), "utf8");
		const len = Buffer.alloc(4);
		len.writeInt32BE(text.length, 0);
		parts.push(len, text);
	}
	return encodeMessage("D", Buffer.concat(parts));
}

function encodeResult(result: {
	command?: string;
	rowCount?: number;
	fields?: Array<{ name: string; dataTypeID: number }>;
	rows?: Array<Record<string, unknown> | unknown[]>;
}): Buffer {
	const chunks: Buffer[] = [];
	const fields = result.fields || [];
	if (fields.length) {
		chunks.push(rowDescription(fields));
		for (const row of result.rows || []) {
			if (Array.isArray(row)) {
				chunks.push(dataRow(row));
			} else {
				chunks.push(dataRow(fields.map((f) => row[f.name])));
			}
		}
	}
	const cmd = result.command || "SELECT";
	const tag =
		cmd === "INSERT"
			? `INSERT 0 ${result.rowCount ?? 0}`
			: `${cmd} ${result.rowCount ?? 0}`;
	chunks.push(commandComplete(fields.length ? tag : cmd === "SET" ? "SET" : tag));
	return Buffer.concat(chunks);
}

module.exports = {
	SSL_REQUEST,
	PROTOCOL_3,
	readCString,
	encodeMessage,
	readyForQuery,
	authenticationOk,
	authenticationCleartext,
	parameterStatus,
	backendKeyData,
	commandComplete,
	parseComplete,
	bindComplete,
	noData,
	errorResponse,
	rowDescription,
	dataRow,
	encodeResult,
};

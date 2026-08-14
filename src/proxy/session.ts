// @ts-nocheck
const { splitStatements, classifyStatement } = require("./tid-sql");
const { lookupHostIndex } = require("./lookup");
const wire = require("./pg-wire");

class ProxySession {
	constructor(socket, { config, pools }) {
		this.socket = socket;
		this.config = config;
		this.pools = pools;
		this.buf = Buffer.alloc(0);
		this.phase = "first";
		this.pendingTid = null;
		this.inTx = false;
		this.pinnedIndex = null;
		this.txClient = null;
		this.backendInTx = false;
		this.unnamedSql = null;
		this.unnamedValues = null;
		this.txStatus = "I";
	}

	start() {
		this.pumping = false;
		this.socket.on("data", (chunk) => {
			this.buf = Buffer.concat([this.buf, chunk]);
			this.enqueuePump();
		});
		this.socket.on("error", () => this.cleanup());
		this.socket.on("close", () => this.cleanup());
	}

	enqueuePump() {
		if (this.pumping) {
			this.needPump = true;
			return;
		}
		this.pumping = true;
		const run = () =>
			this.pump()
				.then(() => {
					if (this.needPump) {
						this.needPump = false;
						return run();
					}
					this.pumping = false;
				})
				.catch((err) => {
					this.pumping = false;
					this.fail(err);
				});
		run();
	}

	fail(err) {
		try {
			this.socket.write(
				Buffer.concat([
					wire.errorResponse(err.message || String(err)),
					wire.readyForQuery(this.txStatus),
				]),
			);
		} catch {
			/* ignore */
		}
	}

	async cleanup() {
		if (this.txClient) {
			try {
				await this.txClient.query("ROLLBACK");
			} catch {
				/* ignore */
			}
			this.txClient.release();
			this.txClient = null;
		}
		this.inTx = false;
		this.backendInTx = false;
		this.pinnedIndex = null;
		this.pendingTid = null;
	}

	async pump() {
		while (this.buf.length > 0) {
			if (this.phase === "first") {
				if (this.buf.length < 8) return;
				const len = this.buf.readInt32BE(0);
				if (len === 8 && this.buf.readInt32BE(4) === wire.SSL_REQUEST) {
					this.buf = this.buf.subarray(8);
					this.socket.write("N");
					continue;
				}
				if (this.buf.length < len) return;
				this.handleStartup(this.buf.subarray(0, len));
				this.buf = this.buf.subarray(len);
				if (!this.config.password) {
					this.sendReady();
					this.phase = "ready";
				} else {
					this.phase = "auth";
					this.socket.write(wire.authenticationCleartext());
				}
				continue;
			}

			if (this.buf.length < 5) return;
			const type = String.fromCharCode(this.buf[0]);
			const len = this.buf.readInt32BE(1);
			const total = 1 + len;
			if (this.buf.length < total) return;
			const payload = this.buf.subarray(5, total);
			this.buf = this.buf.subarray(total);

			if (this.phase === "auth") {
				if (type === "p") {
					const password = payload.toString("utf8").replace(/\0+$/, "");
					if (password !== this.config.password) {
						this.socket.write(
							Buffer.concat([
								wire.errorResponse("password authentication failed", "28P01"),
							]),
						);
						this.socket.end();
						return;
					}
					this.sendReady();
					this.phase = "ready";
				}
				continue;
			}

			if (type === "X") {
				this.socket.end();
				return;
			}
			if (type === "Q") {
				const sql = payload.toString("utf8").replace(/\0+$/, "");
				await this.handleQuery(sql);
				continue;
			}
			if (type === "P") {
				this.handleParse(payload);
				continue;
			}
			if (type === "B") {
				this.handleBind(payload);
				continue;
			}
			if (type === "D") {
				// Do not reply here. node-pg pipelines Parse/Bind/Describe/Execute/Sync.
				// Immediate NoData makes the client drop columns; Execute's encodeResult
				// already emits RowDescription when the statement returns rows.
				continue;
			}
			if (type === "E") {
				await this.handleExecute();
				continue;
			}
			if (type === "S" || type === "H") {
				if (type === "S") this.socket.write(wire.readyForQuery(this.txStatus));
				continue;
			}
			if (type === "C") {
				continue;
			}
			this.socket.write(
				wire.errorResponse(`unsupported frontend message '${type}'`, "0A000"),
			);
			this.socket.write(wire.readyForQuery(this.txStatus));
		}
	}

	handleStartup(buf) {
		let offset = 8;
		while (offset < buf.length - 1) {
			const key = wire.readCString(buf, offset);
			if (!key.value) break;
			const val = wire.readCString(buf, key.next);
			if (key.value === "user") this.startupUser = val.value;
			offset = val.next;
		}
	}

	sendReady() {
		this.socket.write(
			Buffer.concat([
				wire.authenticationOk(),
				wire.parameterStatus("server_version", "16.0"),
				wire.parameterStatus("client_encoding", "UTF8"),
				wire.parameterStatus("DateStyle", "ISO, MDY"),
				wire.backendKeyData(process.pid, (Math.random() * 1e9) | 0),
				wire.readyForQuery("I"),
			]),
		);
		this.txStatus = "I";
	}

	handleParse(payload) {
		let offset = 0;
		const name = wire.readCString(payload, offset);
		const query = wire.readCString(payload, name.next);
		this.unnamedSql = query.value;
		this.socket.write(wire.parseComplete());
	}

	handleBind(payload) {
		let offset = 0;
		const portal = wire.readCString(payload, offset);
		const stmt = wire.readCString(payload, portal.next);
		offset = stmt.next;
		const nFmt = payload.readInt16BE(offset);
		offset += 2 + nFmt * 2;
		const nParams = payload.readInt16BE(offset);
		offset += 2;
		const values = [];
		for (let i = 0; i < nParams; i++) {
			const len = payload.readInt32BE(offset);
			offset += 4;
			if (len < 0) {
				values.push(null);
			} else {
				values.push(payload.toString("utf8", offset, offset + len));
				offset += len;
			}
		}
		this.unnamedValues = values;
		this.socket.write(wire.bindComplete());
	}

	async runSql(sql, values) {
		const statements = splitStatements(sql);
		const chunks = [];
		if (statements.length === 0) {
			chunks.push(wire.commandComplete("EMPTY"));
			return chunks;
		}
		for (const stmt of statements) {
			const kind = classifyStatement(stmt);
			const part = await this.dispatch(kind, values);
			if (part) chunks.push(part);
		}
		this.txStatus = this.inTx ? "T" : "I";
		return chunks;
	}

	async handleExecute() {
		const sql = this.unnamedSql || "";
		const values = this.unnamedValues || [];
		const text =
			/^\s*SET\s+mtdd\.tid/i.test(sql) && values[0] != null
				? `SET mtdd.tid = '${String(values[0]).replace(/'/g, "''")}'`
				: sql;
		try {
			const chunks = await this.runSql(text, values);
			this.socket.write(Buffer.concat(chunks));
		} catch (err) {
			this.socket.write(wire.errorResponse(err.message || String(err)));
		}
	}

	async handleQuery(sql, values = []) {
		try {
			const chunks = await this.runSql(sql, values);
			chunks.push(wire.readyForQuery(this.txStatus));
			this.socket.write(Buffer.concat(chunks));
		} catch (err) {
			this.socket.write(
				Buffer.concat([
					wire.errorResponse(err.message || String(err)),
					wire.readyForQuery(this.inTx ? "E" : "I"),
				]),
			);
		}
	}

	async dispatch(kind, values) {
		if (kind.kind === "set_tid") {
			if (kind.tid === "") {
				throw new Error("mtdd.tid must be a non-empty string");
			}
			if (this.inTx && this.pinnedIndex != null) {
				const next = await lookupHostIndex(
					this.config.lookupUrl,
					kind.tid,
					this.config.shards.length,
				);
				if (next !== this.pinnedIndex) {
					throw new Error(
						`tid maps to shard ${next} but transaction is pinned to shard ${this.pinnedIndex}`,
					);
				}
			}
			this.pendingTid = kind.tid;
			return wire.commandComplete("SET");
		}
		if (kind.kind === "reset_tid") {
			if (this.inTx) {
				throw new Error("RESET mtdd.tid is not allowed inside a transaction");
			}
			this.pendingTid = null;
			return wire.commandComplete("RESET");
		}
		if (kind.kind === "begin") {
			this.inTx = true;
			if (this.pendingTid) await this.ensurePinned(this.pendingTid);
			this.txStatus = "T";
			return wire.commandComplete("BEGIN");
		}
		if (kind.kind === "commit" || kind.kind === "rollback") {
			const tag = kind.kind === "commit" ? "COMMIT" : "ROLLBACK";
			if (this.txClient) {
				this.pools.noteQuery(this.pinnedIndex);
				await this.txClient.query(tag);
				this.txClient.release();
				this.txClient = null;
			}
			this.inTx = false;
			this.backendInTx = false;
			this.pinnedIndex = null;
			this.pendingTid = null;
			this.txStatus = "I";
			return wire.commandComplete(tag);
		}
		return this.runData(kind.sql, values);
	}

	async ensurePinned(tid) {
		const hostIndex = await lookupHostIndex(
			this.config.lookupUrl,
			tid,
			this.config.shards.length,
		);
		if (this.pinnedIndex != null && this.pinnedIndex !== hostIndex) {
			throw new Error(
				`tid maps to shard ${hostIndex} but transaction is pinned to shard ${this.pinnedIndex}`,
			);
		}
		if (this.pinnedIndex == null) {
			this.pinnedIndex = hostIndex;
			this.txClient = await this.pools.connect(hostIndex);
			if (this.inTx && !this.backendInTx) {
				this.pools.noteQuery(hostIndex);
				await this.txClient.query("BEGIN");
				this.backendInTx = true;
			}
		}
		return hostIndex;
	}

	async runData(sql, values) {
		const tid = this.pendingTid;
		if (tid == null || tid === "") {
			throw new Error(
				"mtdd.tid is not set. Issue SET mtdd.tid = '<tid>' before this statement",
			);
		}
		if (this.inTx) {
			await this.ensurePinned(tid);
			this.pools.noteQuery(this.pinnedIndex);
			const result = await this.txClient.query(sql, values);
			return wire.encodeResult(result);
		}
		const hostIndex = await lookupHostIndex(
			this.config.lookupUrl,
			tid,
			this.config.shards.length,
		);
		this.pendingTid = null;
		const result = await this.pools.query(hostIndex, sql, values);
		return wire.encodeResult(result);
	}
}

module.exports = { ProxySession };

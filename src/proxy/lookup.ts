async function lookupHostIndex(lookupUrl: string, tid: string, shardCount: number) {
	const response = await fetch(lookupUrl, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ tid }),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(
			`Lookup returned ${response.status} for tid ${tid}${body ? `: ${body}` : ""}`,
		);
	}
	const payload: any = await response.json();
	const hostIndex = payload?.hostIndex;
	if (typeof hostIndex !== "number" || !Number.isInteger(hostIndex)) {
		throw new Error(`Lookup response missing integer hostIndex for tid ${tid}`);
	}
	if (hostIndex < 0 || hostIndex >= shardCount) {
		throw new Error(
			`Lookup hostIndex ${hostIndex} out of range [0, ${shardCount - 1}] for tid ${tid}`,
		);
	}
	return hostIndex;
}

module.exports = { lookupHostIndex };

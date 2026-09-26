/**
 * The address fields hold what the user typed: a comma-separated list, which
 * is what `<input type="email" multiple>` validates and what a pasted list
 * from another mail client looks like. The send API wants the addresses as an
 * array, so the split happens here, on the way out.
 *
 * Empty entries are dropped rather than sent, because a trailing comma while
 * typing is normal and would otherwise fail validation on the server.
 */
export function splitAddresses(value: string): string[] {
	return commaSeparated(value)
		.map((address) => address.trim())
		.filter(Boolean);
}

/**
 * Split at the commas that separate addresses, not the ones inside them: a
 * quoted local part (`"a,b"@example.com`) or display name (`"Doe, J" <j@x>`)
 * may hold one. Split at every comma, `"a,b"@example.com` became `"a` and
 * `b"@example.com`.
 */
function commaSeparated(value: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quoted = false;
	for (let i = 0; i < value.length; i++) {
		const ch = value[i];
		if (quoted && ch === "\\" && i + 1 < value.length) {
			current += ch + value[++i];
			continue;
		}
		if (ch === '"') quoted = !quoted;
		else if (!quoted && ch === ",") {
			parts.push(current);
			current = "";
			continue;
		}
		current += ch;
	}
	parts.push(current);
	return parts;
}

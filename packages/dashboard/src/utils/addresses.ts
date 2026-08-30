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
	return value
		.split(",")
		.map((address) => address.trim())
		.filter(Boolean);
}

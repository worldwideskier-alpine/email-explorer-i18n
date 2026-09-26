/**
 * The send API takes a recipient list as either a single address or an array
 * of them, because the dashboard sent a bare string before multiple
 * recipients existed and old drafts still round-trip through that shape.
 *
 * Storage is always the comma-separated form the To:/Cc: headers use, so a
 * row written before this existed -- one address, no separator -- is already
 * a valid list of one and needs no migration.
 */
export function formatAddressList(
	value: string | string[] | undefined,
): string | null {
	if (value === undefined) return null;
	const list = (Array.isArray(value) ? value : [value])
		.map((address) => address.trim())
		.filter(Boolean);
	return list.length ? list.join(", ") : null;
}

// RFC 5322 atext, plus anything outside ASCII (RFC 6532 lets UTF-8 stand
// in an atom), in dot-separated runs.
const DOT_ATOM =
	/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~\u0080-\u{10FFFF}-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~\u0080-\u{10FFFF}-]+)*$/u;

/**
 * An address as it has to be written in a header, which is also how it is
 * stored: a local part that is not a plain dot-atom goes back in quotes.
 *
 * postal-mime hands `"a,b"@example.com` back as `a,b@example.com`, with the
 * quotes gone. Stored like that in a comma-separated list, reply-all read it
 * as two addresses, `a` and `b@example.com` -- the second of which is
 * somebody else's.
 */
export function asHeaderAddress(address: string): string {
	const at = address.lastIndexOf("@");
	if (at <= 0) return address;
	const local = address.slice(0, at);
	if (DOT_ATOM.test(local) || /^"(?:[^"\\]|\\.)*"$/.test(local)) {
		return address;
	}
	return `"${local.replace(/["\\]/g, "\\$&")}"${address.slice(at)}`;
}

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

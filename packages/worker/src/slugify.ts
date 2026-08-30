/**
 * Turns a folder name into an id.
 *
 * Shared by the route that creates a folder and the restore path, which has to
 * recreate folders a backup names but the mailbox does not have yet. Both must
 * derive the same id from the same name, or a restore would build a second
 * folder beside an identical one.
 */
export function slugify(text: string) {
	const slug = text
		.toString()
		.toLowerCase()
		.replace(/\s+/g, "-") // Replace spaces with -
		.replace(/[^\w-]+/g, "") // Remove all non-word chars
		.replace(/--+/g, "-") // Replace multiple - with single -
		.replace(/^-+/, "") // Trim - from start of text
		.replace(/-+$/, ""); // Trim - from end of text

	// \w only matches ASCII word characters, so names made mostly or
	// entirely of non-Latin characters (e.g. Japanese) can slugify to
	// nothing meaningful -- empty, or just leftover "-"/"_" separators --
	// and collide with every other such folder.
	const hasContent = /[a-z0-9]/.test(slug);
	return hasContent ? slug : crypto.randomUUID();
}

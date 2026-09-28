/**
 * Turns a folder name into an id.
 *
 * Shared by the route that creates a folder and the restore path, which has to
 * recreate folders a backup names but the mailbox does not have yet. The id is
 * not the name: different names can give the same one ("Spam!" and "spam"),
 * and a name of mostly non-Latin characters gets a random one each time. So a
 * caller that finds the id taken has found another folder, not the one it
 * asked for -- the restore looks folders up by name, and makes its own id
 * when this one belongs to somebody else's folder.
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

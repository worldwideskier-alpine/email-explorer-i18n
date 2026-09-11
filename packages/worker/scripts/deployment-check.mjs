/**
 * Whether the deployment is really serving the build that was just made.
 *
 * A deploy step that exits 0 says the upload was accepted. It does not say
 * that what is now answering requests is that upload. The gap is not
 * theoretical: locally it has already cost this project a whole verification
 * run, where an audit measured a bundle nobody was serving and reported what
 * was expected of it. Production has the same gap and no way to look.
 *
 * So the deploy workflow asks the deployment itself, right after deploying,
 * and the question it asks is the one with an unambiguous answer: does the
 * page reference the entry script this run built, and are the bytes behind
 * that name the bytes on disk? A hash either matches or it does not.
 *
 * No `node:` imports here, so the reasoning can be tested in the Workers pool
 * alongside everything else; the fetching and file reading live in
 * check-deployment.mjs, the same split deployment-config.mjs uses.
 */

/**
 * The one built entry script and stylesheet, from a directory listing.
 *
 * Vite writes exactly one of each, named with a hash of its contents, which
 * is what makes them worth comparing at all. Anything else means the listing
 * is not the build output it was taken for -- a stale directory with two
 * generations in it, say -- and guessing which is current would turn this
 * check into a coin toss.
 */
export function builtAssets(filenames) {
	const pick = (extension) => {
		const found = filenames
			.filter((name) => name.startsWith("index-") && name.endsWith(extension))
			.sort();
		if (found.length !== 1) {
			throw new Error(
				`expected exactly one built index${extension}, found ${found.length}${
					found.length ? `: ${found.join(", ")}` : ""
				}`,
			);
		}
		return found[0];
	};
	return { js: pick(".js"), css: pick(".css") };
}

/** Every hashed asset the page asks the browser to load, in the order given. */
export function assetsReferencedBy(html) {
	return [
		...html.matchAll(/\/assets\/(index-[A-Za-z0-9_-]+\.(?:js|css))/g),
	].map((match) => match[1]);
}

/**
 * What the served page is missing, or null when it asks for the build.
 *
 * Only the two entry names are checked. Everything else the page loads is
 * reached from them, so a page on the right entry script is on the right
 * everything; a page on the wrong one is stale no matter what else it lists.
 */
export function assetMismatch(built, html) {
	const referenced = assetsReferencedBy(html);
	const missing = [built.js, built.css].filter(
		(name) => !referenced.includes(name),
	);
	if (missing.length === 0) return null;
	const has = referenced.length
		? referenced.join(", ")
		: "no built asset at all";
	return `the page loads ${has}, not ${missing.join(" and ")}`;
}

/**
 * Whether a response came from the Worker rather than from the assets.
 *
 * The asset handler answers anything it does not have with `index.html`, so
 * an API path that comes back as HTML has not reached the Worker: the routes
 * are gone, or `run_worker_first` no longer covers them, and every screen
 * would sign out. The status is deliberately not pinned -- an unauthenticated
 * request to an API path is *supposed* to be refused, and 401 is as good an
 * answer as 200 here. What cannot happen is the page.
 */
export function answeredByTheWorker(status, contentType) {
	return status < 500 && /application\/json/i.test(contentType ?? "");
}

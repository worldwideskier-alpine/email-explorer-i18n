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

/**
 * Why the page may be stored but never used without asking first.
 *
 * Everything under /assets/ is named with a hash of its contents, so it can
 * be kept forever. index.html cannot: its name never changes while its
 * contents do, and its contents are the only place the new asset names are
 * written. A page held in a cache for an hour is an hour in which a deployed
 * fix does not exist as far as that browser is concerned.
 *
 * This is a guard rather than a repair. Measured against the local runtime,
 * the assets handler already answers the page with `max-age=0`, and the
 * deployment's own `_headers` now says `no-cache` outright; what has actually
 * cost this project a fix is the case no header reaches -- a page kept on a
 * home screen, resumed rather than loaded, which asks for nothing for days.
 * That is handled in the dashboard (services/appUpdate.ts). What is held here
 * is that the header does not quietly become a long one later.
 *
 * So `no-cache` or `no-store` or `max-age=0`: any of the three means the
 * browser comes back and asks. `must-revalidate` on its own is not enough --
 * it only says what to do once the age is up, so `max-age=600,
 * must-revalidate` is still ten minutes of the old page. A missing header is
 * the worst of the lot, because then the cache invents a lifetime of its own.
 *
 * Returns what is wrong with the header, or null when it is fine.
 */
export function staleServedPage(cacheControl) {
	const value = (cacheControl ?? "").trim();
	if (!value) return "the page is served with no Cache-Control at all";
	const directives = value.toLowerCase().split(/\s*,\s*/);
	if (directives.includes("no-cache") || directives.includes("no-store")) {
		return null;
	}
	const maxAge = directives
		.map((directive) => /^max-age=(\d+)$/.exec(directive)?.[1])
		.find((seconds) => seconds !== undefined);
	if (maxAge === "0") return null;
	return `the page is served with "${value}", so a browser may use an old one without asking`;
}

/**
 * The version `wrangler deployments status` says is live, from its output:
 * the line `Version(s):  (100%) <id>`. Null when it says no such thing -- a
 * split deployment, or a read that failed -- and then nothing is compared.
 */
export function liveVersionIn(statusOutput) {
	const found = /Version\(s\):\s*\(100%\)\s*([0-9a-f-]{36})/i.exec(
		statusOutput ?? "",
	);
	return found ? found[1].toLowerCase() : null;
}

/**
 * Whether the Worker answering is the version that was published.
 *
 * The page and its bundle prove the assets; a change to the Worker alone
 * leaves both exactly as they were, so a deploy of only Worker code passed
 * this check whether or not the new code was running. The Worker says which
 * version it is (the `version_metadata` binding, in /api/v1/settings).
 *
 * Returns what is wrong, or null when it is the one -- or when there is
 * nothing to compare against.
 */
export function workerVersionMismatch(expected, served) {
	if (!expected) return null;
	if (!served) return "the Worker does not say which version it is";
	return served.toLowerCase() === expected.toLowerCase()
		? null
		: `the Worker answering is version ${served}, not ${expected}`;
}

/**
 * Every address `wrangler deploy` says it deployed to: the `https://` lines
 * under its "Deployed <name> triggers" line -- workers.dev, then any route or
 * custom domain. Empty when it names none.
 *
 * Read from wrangler's own output so that nothing has to be set for the check
 * to run: it used to need the address as a GitHub secret, which a fork had to
 * know to make, and without which its deploys went unchecked -- and with the
 * check, the rollback that hangs on it. The output is read from a file the
 * deploy step writes, never from the log, which has every address struck out.
 */
export function deployedAddresses(deployOutput) {
	const lines = (deployOutput ?? "").split(/\r?\n/);
	const at = lines.findIndex((line) =>
		/^\s*Deployed \S+ triggers\b/.test(line),
	);
	if (at < 0) return [];
	const found = [];
	for (const line of lines.slice(at + 1)) {
		if (!/^\s/.test(line)) break;
		const url = /^\s+(https:\/\/[^\s()]+)\s*$/.exec(line);
		if (url) found.push(url[1].replace(/\/+$/, ""));
	}
	return found;
}

/** The first of them, which the deploy's check asks; null when none. */
export function deployedAddress(deployOutput) {
	return deployedAddresses(deployOutput)[0] ?? null;
}

/**
 * Whether an answer is Cloudflare Access standing in front of the
 * deployment: a redirect to a team's sign-in page at `*.cloudflareaccess.com`.
 *
 * Behind Access nothing here can ask the deployment what it serves -- the
 * runner is nobody Access lets in -- and asking anyway failed every deploy
 * and rolled it back. Told apart by the redirect's host, so that a deployment
 * that answers wrongly in any other way still fails.
 */
export function behindAccess(status, location) {
	if (![301, 302, 303, 307, 308].includes(status) || !location) return false;
	try {
		return /(^|\.)cloudflareaccess\.com$/i.test(new URL(location).hostname);
	} catch {
		return false;
	}
}

/**
 * The Access team a sign-in redirect names, as the issuer its tokens carry:
 * `https://<team>.cloudflareaccess.com`. Null for anything else.
 *
 * The deploy writes this for the Worker (cloudflare-access.ts), which then
 * refuses every request that does not carry a token that team signed. Read
 * from the redirect the deployment itself answered the runner with, so it is
 * the team actually in front -- never one a request names.
 */
export function accessTeamFrom(status, location) {
	if (!behindAccess(status, location)) return null;
	try {
		const url = new URL(location);
		const issuer = `https://${url.hostname.toLowerCase()}`;
		return url.protocol === "https:" &&
			url.port === "" &&
			/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(
				issuer,
			)
			? issuer
			: null;
	} catch {
		return null;
	}
}

/**
 * The application a sign-in redirect is for: its `kid`, which names the
 * application by its audience tag (64 hex digits). Null when there is none
 * of that shape, and the Worker then learns it from the first token of the
 * team instead.
 */
export function accessAudienceFrom(location) {
	try {
		const kid = new URL(location).searchParams.get("kid") ?? "";
		return /^[0-9a-f]{64}$/.test(kid) ? kid : null;
	} catch {
		return null;
	}
}

/**
 * How one address answered for one path, as far as Access is concerned:
 *
 *   behind  -- a team's sign-in redirect, with its team and application.
 *   open    -- the page or the API itself (200, no redirect).
 *   unknown -- anything else: an error, a redirect elsewhere, no answer.
 */
export function accessDoor(status, location) {
	const issuer = accessTeamFrom(status, location);
	if (issuer) {
		return { door: "behind", issuer, audience: accessAudienceFrom(location) };
	}
	if (status === 200 && !location) return { door: "open" };
	return { door: "unknown" };
}

/**
 * What the deploy does about the Worker's Access settings, from every answer
 * it had -- each address wrangler deployed to, each asked for its page and
 * for an API path:
 *
 *   behind  -- any of them is behind a team: write that team, and the
 *              applications if every one of them named its own. One address
 *              Access does not cover is exactly where the Worker's own check
 *              is needed, so it does not outvote one that is covered.
 *   open    -- every one answered without Access: delete the settings, or
 *              the Worker would refuse every request, which has no token
 *              once Access is off.
 *   unknown -- two teams, or no clear answer: leave them as they are.
 */
export function accessDoorOf(answers) {
	const behind = answers.filter((answer) => answer.door === "behind");
	if (behind.length > 0) {
		const issuers = new Set(behind.map((answer) => answer.issuer));
		if (issuers.size !== 1) return { door: "unknown", reason: "two teams" };
		const audiences = behind.every((answer) => answer.audience)
			? [...new Set(behind.map((answer) => answer.audience))].sort()
			: [];
		return { door: "behind", issuer: behind[0].issuer, audiences };
	}
	if (answers.length > 0 && answers.every((answer) => answer.door === "open")) {
		return { door: "open" };
	}
	return { door: "unknown" };
}

import { describe, expect, it } from "vitest";
// Plain JS on purpose: this module also runs under node from the deploy
// workflow, where there is nothing to compile it. allowJs types it here.
import {
	accessAudienceFrom,
	accessDoor,
	accessDoorOf,
	accessTeamFrom,
	answeredByTheWorker,
	assetMismatch,
	assetsReferencedBy,
	behindAccess,
	builtAssets,
	deployedAddress,
	deployedAddresses,
	liveVersionIn,
	staleServedPage,
	workerVersionMismatch,
} from "../../scripts/deployment-check.mjs";

/**
 * Asking the live deployment what it is serving.
 *
 * The deploy step exiting 0 means the upload was accepted, not that the
 * upload is what answers requests. Locally that gap has already produced a
 * verification run that measured a bundle nobody was serving and agreed with
 * whatever was expected of it; the workflow now compares the built entry
 * script's name and bytes against what production hands back.
 *
 * The requests themselves cannot be tested from here -- there is no
 * deployment in the test pool -- so what is held is the reasoning: which file
 * is the build, whether a page is on it, and whether an answer came from the
 * Worker or from the page being served in its place.
 */

/** The shape of the real built index.html, entry tags and all. */
const PAGE = `<!DOCTYPE html>
<html lang="">
  <head>
    <meta charset="UTF-8">
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <title>Email Explorer</title>
    <script type="module" crossorigin src="/assets/index-C9t9Pt6p.js"></script>
    <link rel="stylesheet" crossorigin href="/assets/index-D-tSnx3s.css">
  </head>
  <body><div id="app"></div></body>
</html>`;

/** What the assets directory really looks like: 75 files, two of them entries. */
const LISTING = [
	"ar-CjxRGb0G.js",
	"be-5rVYOA1O.js",
	"index-C9t9Pt6p.js",
	"index-D-tSnx3s.css",
	"ja-BqR1x9Zz.js",
];

describe("which file is the build", () => {
	it("finds the entry script and stylesheet among the locale chunks", () => {
		expect(builtAssets(LISTING)).toEqual({
			js: "index-C9t9Pt6p.js",
			css: "index-D-tSnx3s.css",
		});
	});

	/**
	 * Two generations in one directory is the case worth refusing. Picking
	 * either would make the comparison downstream a coin toss, and a check
	 * that passes half the time by accident is worse than no check.
	 */
	it("refuses a listing it cannot read one build out of", () => {
		expect(() => builtAssets([...LISTING, "index-Deadbeef.js"])).toThrow(
			/found 2/,
		);
		expect(() => builtAssets(["ja-BqR1x9Zz.js"])).toThrow(/found 0/);
	});
});

describe("whether the page is on that build", () => {
	it("reads both entry names out of the page", () => {
		expect(assetsReferencedBy(PAGE)).toEqual([
			"index-C9t9Pt6p.js",
			"index-D-tSnx3s.css",
		]);
	});

	it("says nothing when the page loads the build", () => {
		expect(
			assetMismatch(
				{ js: "index-C9t9Pt6p.js", css: "index-D-tSnx3s.css" },
				PAGE,
			),
		).toBeNull();
	});

	it("names what is being served instead", () => {
		const message = assetMismatch(
			{ js: "index-NewBuild1.js", css: "index-NewBuild2.css" },
			PAGE,
		);
		expect(message).toContain("index-C9t9Pt6p.js");
		expect(message).toContain("index-NewBuild1.js");
	});

	it("does not mistake an error page for a stale one", () => {
		const message = assetMismatch(
			{ js: "index-C9t9Pt6p.js", css: "index-D-tSnx3s.css" },
			"<html><body>error 1016</body></html>",
		);
		expect(message).toContain("no built asset at all");
	});
});

describe("whether an answer came from the Worker", () => {
	/**
	 * The one that matters: the asset handler answers anything it has no file
	 * for with index.html, so a broken API route comes back 200 text/html and
	 * looks perfectly healthy to anything that only checks the status.
	 */
	it("is not fooled by the page being served in the Worker's place", () => {
		expect(answeredByTheWorker(200, "text/html; charset=utf-8")).toBe(false);
	});

	it("counts a refusal, because a refusal is the Worker speaking", () => {
		// An unauthenticated request to an API path is supposed to be turned
		// away. Pinning 200 here would fail every run.
		expect(answeredByTheWorker(401, "application/json")).toBe(true);
		expect(answeredByTheWorker(200, "application/json; charset=utf-8")).toBe(
			true,
		);
	});

	it("does not count the Worker falling over", () => {
		expect(answeredByTheWorker(500, "application/json")).toBe(false);
		expect(answeredByTheWorker(200, null)).toBe(false);
	});
});

describe("whether a browser will come back for the page", () => {
	/**
	 * The page is the only place the new asset names are written, so a
	 * browser holding an old copy is a browser on an old build however
	 * thoroughly the deploy succeeded.
	 */
	it('accepts the ways of saying "ask again"', () => {
		expect(staleServedPage("no-cache")).toBeNull();
		expect(staleServedPage("public, max-age=0, must-revalidate")).toBeNull();
		expect(staleServedPage("no-store")).toBeNull();
		// Whatever case and spacing the edge chooses to send it in.
		expect(staleServedPage("Public,  Max-Age=0,  Must-Revalidate")).toBeNull();
	});

	/**
	 * `must-revalidate` is about what to do once the copy is stale, not about
	 * when it becomes stale. Ten minutes of max-age is ten minutes in which a
	 * deployed fix does not exist for that browser, revalidation or not -- and
	 * this is the shape a well-meant "let's cache the page a bit" would take.
	 */
	it("is not talked round by must-revalidate on a long max-age", () => {
		const message = staleServedPage("public, max-age=600, must-revalidate");
		expect(message).toContain("without asking");
		expect(staleServedPage("max-age=31536000, immutable")).toContain(
			"without asking",
		);
	});

	it("counts no header at all as the worst case", () => {
		// With nothing said, a cache is free to invent a lifetime.
		expect(staleServedPage("")).toContain("no Cache-Control");
		expect(staleServedPage(null)).toContain("no Cache-Control");
		expect(staleServedPage(undefined)).toContain("no Cache-Control");
	});
});

/**
 * Whether the Worker answering is the one just published. The page and its
 * bundle prove the assets only; a change to the Worker alone left both as
 * they were, so a deploy of Worker code passed whether or not it was running.
 */
describe("the Worker's version", () => {
	const ID = "57c9b824-4a2d-489f-ab32-47a71a3e0a40";

	it("is read from what wrangler says is live", () => {
		expect(
			liveVersionIn(`Created:     2026-09-29\nVersion(s):  (100%) ${ID}\n`),
		).toBe(ID);
		// A split deployment names no one version.
		expect(
			liveVersionIn(`Version(s):  (60%) ${ID}\n             (40%) ${ID}`),
		).toBeNull();
		expect(liveVersionIn("could not read the live version back")).toBeNull();
	});

	it("must be the one published, when one was read back", () => {
		expect(workerVersionMismatch(ID, ID)).toBeNull();
		expect(workerVersionMismatch(ID, ID.toUpperCase())).toBeNull();
		expect(workerVersionMismatch(ID, "0".repeat(36))).toMatch(/not/);
		expect(workerVersionMismatch(ID, null)).toMatch(/does not say/);
		expect(workerVersionMismatch("", "anything")).toBeNull();
	});
});

/**
 * The address the check asks, read from what `wrangler deploy` printed --
 * so that a deployment checks itself with nothing set, where it used to need
 * the address as a GitHub secret and was unchecked without one.
 */
describe("the address wrangler deployed to", () => {
	const deployed = (...after: string[]) =>
		[
			"Uploaded email-explorer-x (5.11 sec)",
			"Deployed email-explorer-x triggers (0.59 sec)",
			...after,
			"Current Version ID: 4d8d17b8-cf11-4e10-9be0-1d3a28084517",
		].join("\n");

	it("is the https line under the triggers line", () => {
		expect(
			deployedAddress(
				deployed(
					"  https://email-explorer-x.someone.workers.dev",
					"  schedule: 0 18 * * *",
				),
			),
		).toBe("https://email-explorer-x.someone.workers.dev");
	});

	it("is the first of several, without a trailing slash", () => {
		expect(
			deployedAddress(
				deployed(
					"  https://a.someone.workers.dev/",
					"  https://b.someone.workers.dev",
				),
			),
		).toBe("https://a.someone.workers.dev");
	});

	it.each([
		[
			"no deploy, though an address is printed",
			"Error: authentication failed\n  https://dash.cloudflare.com/profile/api-tokens",
		],
		["no address under it", deployed("  schedule: 0 18 * * *")],
		// What the log shows: struck out, it is no address.
		["only what the log shows", deployed("  https://(address withheld)")],
		["a struck-out address", deployed("  https://(withheld)")],
		[
			"an address before the triggers line",
			"  https://elsewhere.example\nDeployed x triggers (1 sec)\n  schedule: 0 18 * * *",
		],
		[
			"an address after the indented block ends",
			`${deployed("  schedule: 0 18 * * *")}\n  https://later.example`,
		],
	])("is none when there is %s", (_, output) => {
		expect(deployedAddress(output)).toBeNull();
	});
});

/**
 * Cloudflare Access in front of the deployment turns the runner away with a
 * redirect to the team's sign-in page. Asked anyway, the check failed and
 * every deploy was rolled back; told apart by the redirect's host alone, so
 * that any other wrong answer still fails.
 */
describe("a deployment behind Cloudflare Access", () => {
	it("is a redirect to a team's sign-in page", () => {
		expect(
			behindAccess(
				302,
				"https://team.cloudflareaccess.com/cdn-cgi/access/login/x?kid=1",
			),
		).toBe(true);
		expect(behindAccess(303, "https://team.cloudflareaccess.com/")).toBe(true);
	});

	it.each([
		["a page", 200, null],
		["a refusal", 403, null],
		["a redirect elsewhere", 302, "https://example.org/login"],
		["a look-alike host", 302, "https://cloudflareaccess.com.evil.example/"],
		["a redirect with no location", 302, null],
		["a location that is no URL", 302, "/cdn-cgi/access/login"],
		[
			"the right host on an answer that is no redirect",
			200,
			"https://team.cloudflareaccess.com/",
		],
	])("is not %s", (_, status, location) => {
		expect(behindAccess(status as number, location as string | null)).toBe(
			false,
		);
	});
});

/**
 * The team the deploy writes for the Worker, read off the same redirect. A
 * wrong one refuses the owner on every request, and none at all leaves the
 * Worker checking nothing, so only a team's own address is taken.
 */
describe("the Access team a deployment's redirect names", () => {
	it("is the sign-in page's host, as the issuer its tokens carry", () => {
		expect(
			accessTeamFrom(
				302,
				"https://My-Team.cloudflareaccess.com/cdn-cgi/access/login/host?kid=abc&redirect_url=%2F",
			),
		).toBe("https://my-team.cloudflareaccess.com");
	});

	it.each([
		["a page", 200, null],
		["a redirect elsewhere", 302, "https://example.org/login"],
		[
			"a look-alike host",
			302,
			"https://team.cloudflareaccess.com.evil.example/",
		],
		["the bare domain, which is no team", 302, "https://cloudflareaccess.com/"],
		["a team below a team", 302, "https://a.b.cloudflareaccess.com/"],
		["plain http", 302, "http://team.cloudflareaccess.com/"],
		["a port of its own", 302, "https://team.cloudflareaccess.com:8443/"],
		[
			"a host with a trailing hyphen",
			302,
			"https://team-.cloudflareaccess.com/",
		],
	])("is none for %s", (_, status, location) => {
		expect(
			accessTeamFrom(status as number, location as string | null),
		).toBeNull();
	});
});

const KID = "a".repeat(64);
const SIGN_IN = `https://team.cloudflareaccess.com/cdn-cgi/access/login/h?kid=${KID}&redirect_url=%2F`;

describe("the application a sign-in redirect is for", () => {
	it("is its kid, when it has the shape of an audience tag", () => {
		expect(accessAudienceFrom(SIGN_IN)).toBe(KID);
	});

	it.each([
		["no kid", "https://team.cloudflareaccess.com/cdn-cgi/access/login/h"],
		["a short one", "https://team.cloudflareaccess.com/x?kid=abc"],
		["capitals", `https://team.cloudflareaccess.com/x?kid=${"A".repeat(64)}`],
		[
			"one too long",
			`https://team.cloudflareaccess.com/x?kid=${"a".repeat(65)}`,
		],
		["no URL", "/cdn-cgi/access/login"],
	])("is none for %s", (_, location) => {
		expect(accessAudienceFrom(location)).toBeNull();
	});
});

describe("how one answer stands", () => {
	it("is behind a team, with its application, at a team's sign-in", () => {
		expect(accessDoor(302, SIGN_IN)).toEqual({
			door: "behind",
			issuer: "https://team.cloudflareaccess.com",
			audience: KID,
		});
	});

	it("is open when the page itself answers", () => {
		expect(accessDoor(200, null)).toEqual({ door: "open" });
	});

	it.each([
		["an error", 500, null],
		["a refusal", 403, null],
		["a redirect elsewhere", 302, "https://example.org/"],
		["a sign-in redirect at no team", 302, "https://cloudflareaccess.com/"],
		["a sign-in redirect over http", 302, "http://team.cloudflareaccess.com/"],
	])("is unknown on %s", (_, status, location) => {
		expect(accessDoor(status as number, location as string | null)).toEqual({
			door: "unknown",
		});
	});
});

/**
 * Every address the deploy reached, each asked for its page and an API path.
 * Deleting the settings when one address answered without Access turned the
 * Worker's check off where it was needed most: an address Access does not
 * cover, beside one it does.
 */
describe("what the deploy does about the Worker's Access settings", () => {
	const behind = (
		audience: string | null = KID,
		issuer = "https://team.cloudflareaccess.com",
	) => ({ door: "behind", issuer, audience }) as const;
	const open = { door: "open" } as const;
	const unknown = { door: "unknown" } as const;

	it("writes the team and its applications when any answer is behind it", () => {
		expect(accessDoorOf([open, behind(), open, unknown])).toEqual({
			door: "behind",
			issuer: "https://team.cloudflareaccess.com",
			audiences: [KID],
		});
		expect(
			accessDoorOf([behind("b".repeat(64)), behind(KID), behind(KID)]),
		).toEqual({
			door: "behind",
			issuer: "https://team.cloudflareaccess.com",
			audiences: [KID, "b".repeat(64)],
		});
	});

	it("writes no application when one answer named none, so it is learned", () => {
		expect(accessDoorOf([behind(), behind(null)])).toEqual({
			door: "behind",
			issuer: "https://team.cloudflareaccess.com",
			audiences: [],
		});
	});

	it("deletes them only when every answer came without Access", () => {
		expect(accessDoorOf([open, open, open, open])).toEqual({ door: "open" });
		expect(accessDoorOf([open, unknown]).door).toBe("unknown");
		expect(accessDoorOf([]).door).toBe("unknown");
	});

	it("leaves them alone when two teams answer", () => {
		expect(
			accessDoorOf([
				behind(),
				behind(KID, "https://other.cloudflareaccess.com"),
			]).door,
		).toBe("unknown");
	});
});

describe("every address wrangler deployed to", () => {
	it("is each https line under the triggers line", () => {
		const output = [
			"Uploaded my-worker (3.1 sec)",
			"Deployed my-worker triggers (1.2 sec)",
			"  https://my-worker.example.workers.dev",
			"  mail.example.org (custom domain)",
			"  https://mail.example.org/",
			"  schedule: 0 18 * * *",
			"Current Version ID: 00000000-0000-0000-0000-000000000000",
		].join("\n");
		expect(deployedAddresses(output)).toEqual([
			"https://my-worker.example.workers.dev",
			"https://mail.example.org",
		]);
		expect(deployedAddress(output)).toBe(
			"https://my-worker.example.workers.dev",
		);
		expect(deployedAddresses("nothing deployed")).toEqual([]);
	});
});

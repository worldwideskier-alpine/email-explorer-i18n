/**
 * Asks the live deployment what it is serving, and compares it with the build
 * that was just uploaded. See deployment-check.mjs for why.
 *
 * Asks the address `wrangler deploy` reported (the deploy step keeps its
 * output in $RUNNER_TEMP/deploy-output.txt, out of the log), or, when it
 * reported none, `PRODUCTION_URL`. It prints none of either, and has the
 * runner mask the host before anything else: this repository is public, its
 * Actions logs are public with it, and a host in a failed request's message
 * would otherwise be published.
 *
 * Nothing here signs in or writes anything. Four unauthenticated requests.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	answeredByTheWorker,
	assetMismatch,
	behindAccess,
	builtAssets,
	deployedAddress,
	staleServedPage,
	workerVersionMismatch,
} from "./deployment-check.mjs";

const ASSETS = fileURLToPath(new URL("../dashboard/assets", import.meta.url));
// About a minute. Twelve seconds was not always enough: on 2026-09-26 one
// deploy was still serving the previous page after five tries three seconds
// apart and failed the run, and the same commit re-run a minute later passed
// on the first try. What is being waited for is Cloudflare's edge, not this
// build.
const ATTEMPTS = 20;
const PAUSE_MS = 3000;
const REQUEST_TIMEOUT_MS = 15_000;

// From the step before, which read it out of `wrangler deployments status`.
const expectedVersion = (process.env.EXPECTED_WORKER_VERSION ?? "").trim();
if (!expectedVersion) {
	console.log(
		"no published version was read back, so the Worker's is not compared",
	);
}

const output = join(process.env.RUNNER_TEMP ?? "", "deploy-output.txt");
const reported = existsSync(output)
	? deployedAddress(readFileSync(output, "utf8"))
	: null;
const base = (reported ?? process.env.PRODUCTION_URL ?? "")
	.trim()
	.replace(/\/+$/, "");
if (!base) {
	// A Worker with no workers.dev address and no route, and no address set:
	// nothing to ask. Said as a warning, because a change in what wrangler
	// prints would look the same, and an unchecked deploy should not pass
	// unnoticed.
	console.log(
		"::warning::wrangler reported no address it deployed to, and PRODUCTION_URL is not set, so what is served was not checked",
	);
	process.exit(0);
}
try {
	console.log(`::add-mask::${new URL(base).host}`);
} catch {
	console.log("::error::the address to check is not a URL");
	process.exit(1);
}
console.log(
	reported
		? "asking the address wrangler reported it deployed to"
		: "asking PRODUCTION_URL, since wrangler reported no address",
);

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Behind Cloudflare Access the runner is turned away at the door, so what is
// served cannot be asked; the version Cloudflare reports live (the step
// before) is all there is to go on. Said, and not failed: failing rolled
// every deploy back. The redirect names the team; nothing of it is printed.
try {
	const door = await fetch(`${base}/`, {
		// Asked as a browser asks for a page, which Access answers with
		// its sign-in redirect.
		headers: { accept: "text/html" },
		redirect: "manual",
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (behindAccess(door.status, door.headers.get("location"))) {
		console.log(
			"the deployment is behind Cloudflare Access, which this runner cannot pass, so what it serves was not asked",
		);
		console.log(
			expectedVersion
				? `Cloudflare reports version ${expectedVersion} live, the one published`
				: "::warning::and no live version was read back either, so nothing about this deploy was checked",
		);
		process.exit(0);
	}
} catch {
	// Not answered at all: the checks below retry and report it.
}

const built = builtAssets(readdirSync(ASSETS));
const localJs = readFileSync(`${ASSETS}/${built.js}`);
console.log(`built: ${built.js}, ${built.css}`);

/** One pass over the four questions. Returns the problems it found. */
async function inspect() {
	const problems = [];
	const get = async (path, as) => {
		const response = await fetch(`${base}${path}`, {
			headers: { "cache-control": "no-cache" },
			redirect: "follow",
			// A request that hangs is one more try, not the whole job.
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		return {
			status: response.status,
			type: response.headers.get("content-type") ?? "",
			cacheControl: response.headers.get("cache-control") ?? "",
			body:
				as === "bytes"
					? new Uint8Array(await response.arrayBuffer())
					: await response.text(),
		};
	};

	const page = await get("/", "text");
	if (page.status !== 200) {
		problems.push(`the page answered ${page.status}`);
	} else {
		const mismatch = assetMismatch(built, page.body);
		if (mismatch) problems.push(mismatch);
		else console.log("the page loads the build that was just uploaded");

		// And that a browser will come back for it. The page is the only
		// place the new asset names are written, so a cached one is a
		// deployment that has not happened yet.
		const stale = staleServedPage(page.cacheControl);
		if (stale) problems.push(stale);
		else
			console.log(
				`the page is asked for again every time (${page.cacheControl})`,
			);
	}

	const script = await get(`/assets/${built.js}`, "bytes");
	if (script.status !== 200) {
		problems.push(`the entry script answered ${script.status}`);
	} else {
		const served = sha256(script.body);
		const local = sha256(localJs);
		if (served !== local) {
			problems.push(
				`the entry script has the right name and the wrong bytes: ${served.slice(0, 12)} served, ${local.slice(0, 12)} built`,
			);
		} else {
			console.log(
				`the bytes behind that name match: sha256 ${local.slice(0, 12)}…`,
			);
		}
	}

	// A deep path no file sits at: the deployment has to fall back to the
	// page, or a reader who bookmarked a mailbox gets nothing.
	const deep = await get("/login", "text");
	if (deep.status !== 200 || !/text\/html/i.test(deep.type)) {
		problems.push(
			`a deep path answered ${deep.status} ${deep.type} instead of the page`,
		);
	} else {
		console.log("a deep path still falls back to the page");
	}

	// And the Worker itself, which the assets cannot answer for.
	const api = await get("/openapi.json", "text");
	if (!answeredByTheWorker(api.status, api.type)) {
		problems.push(
			`an API path answered ${api.status} ${api.type}, which is not the Worker`,
		);
	} else {
		console.log(`the Worker is answering API paths (${api.status})`);
	}

	// And that it is the version just published; see workerVersionMismatch.
	if (expectedVersion) {
		const settings = await get("/api/v1/settings", "text");
		let served = null;
		try {
			served = JSON.parse(settings.body)?.version ?? null;
		} catch {
			served = null;
		}
		const wrong = workerVersionMismatch(expectedVersion, served);
		if (wrong) problems.push(wrong);
		else console.log(`the Worker running is the version published (${served})`);
	}

	return problems;
}

// Retried because a deploy has just happened and the edge is entitled to a
// moment. Retried whole rather than per-request: the interesting failure is a
// deployment still on the old build, and that is one state, not four.
let problems = [];
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
	// A request that fails outright (DNS, TLS, a refused connection) is one
	// more thing to retry, and is reported by its code alone: Node's own text
	// for it names the host -- "getaddrinfo ENOTFOUND mail.example.com" -- and
	// the secret this log masks is the whole URL, not the bare hostname.
	try {
		problems = await inspect();
	} catch (e) {
		const code = e?.cause?.code ?? e?.code ?? e?.name ?? "error";
		problems = [`the request failed (${code})`];
	}
	if (problems.length === 0) break;
	if (attempt < ATTEMPTS) {
		console.log(
			`not settled yet (${problems.length}); attempt ${attempt} of ${ATTEMPTS}`,
		);
		await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
	}
}

if (problems.length > 0) {
	console.log("");
	for (const problem of problems)
		console.log(`NOT SERVING THE BUILD: ${problem}`);
	process.exit(1);
}
console.log("");
console.log("the deployment is serving this build.");

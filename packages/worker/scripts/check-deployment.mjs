/**
 * Asks the live deployment what it is serving, and compares it with the build
 * that was just uploaded. See deployment-check.mjs for why.
 *
 * Reads the address from `PRODUCTION_URL` and prints none of it. That is not
 * decoration: this repository is public, its Actions logs are public with it,
 * and an address in a repository variable would be echoed into every run's
 * log by the runner itself. A secret is redacted wherever it appears --
 * including in the line wrangler prints when it deploys -- which is the whole
 * reason the address is kept as one.
 *
 * Nothing here signs in or writes anything. Four unauthenticated requests.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	answeredByTheWorker,
	assetMismatch,
	builtAssets,
} from "./deployment-check.mjs";

const ASSETS = fileURLToPath(new URL("../dashboard/assets", import.meta.url));
const ATTEMPTS = 5;
const PAUSE_MS = 3000;

const base = (process.env.PRODUCTION_URL ?? "").trim().replace(/\/+$/, "");
if (!base) {
	// A fork that has not set the address gets the deploy and no check. The
	// workflow skips this step in that case; this is the belt for the braces.
	console.log("PRODUCTION_URL is not set, so there is nothing to check.");
	process.exit(0);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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
		});
		return {
			status: response.status,
			type: response.headers.get("content-type") ?? "",
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

	return problems;
}

// Retried because a deploy has just happened and the edge is entitled to a
// moment. Retried whole rather than per-request: the interesting failure is a
// deployment still on the old build, and that is one state, not four.
let problems = [];
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
	problems = await inspect();
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

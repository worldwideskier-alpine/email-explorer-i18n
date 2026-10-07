/**
 * Asks the deployed address for its front page, without following a
 * redirect, and says what the deploy should do about the Worker's Access
 * settings (accessDoor in deployment-check.mjs): `behind`, `open` or
 * `unknown`, written to $RUNNER_TEMP/access-door.txt. When `behind`, the
 * settings to write are in $RUNNER_TEMP/access.json.
 *
 * The address is the one `wrangler deploy` reported (see check-deployment.mjs),
 * or PRODUCTION_URL. Neither it nor the team is printed: both are masked
 * before anything else, since this repository's logs are public.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accessDoor, deployedAddress } from "./deployment-check.mjs";

const TEMP = process.env.RUNNER_TEMP ?? "";
const VERDICT = join(TEMP, "access-door.txt");
const SETTINGS = join(TEMP, "access.json");
const ATTEMPTS = 5;
const PAUSE_MS = 3000;

writeFileSync(VERDICT, "unknown\n");

const output = join(TEMP, "deploy-output.txt");
const reported = existsSync(output)
	? deployedAddress(readFileSync(output, "utf8"))
	: null;
const base = (reported ?? process.env.PRODUCTION_URL ?? "")
	.trim()
	.replace(/\/+$/, "");
if (!base) {
	console.log("no address to ask");
	process.exit(0);
}
try {
	console.log(`::add-mask::${new URL(base).host}`);
} catch {
	console.log("the address to ask is not a URL");
	process.exit(0);
}

let verdict = { door: "unknown" };
for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
	try {
		const response = await fetch(`${base}/`, {
			// Asked as a browser asks for a page, which Access answers with
			// its sign-in redirect.
			headers: { accept: "text/html" },
			redirect: "manual",
			signal: AbortSignal.timeout(15_000),
		});
		verdict = accessDoor(response.status, response.headers.get("location"));
		console.log(`the front page answered ${response.status}`);
	} catch (e) {
		// By its code alone: Node's own text names the host.
		console.log(
			`the request failed (${e?.cause?.code ?? e?.code ?? e?.name ?? "error"})`,
		);
	}
	if (verdict.door !== "unknown") break;
	if (attempt < ATTEMPTS) {
		await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
	}
}

if (verdict.door === "behind") {
	console.log(`::add-mask::${new URL(verdict.issuer).host}`);
	writeFileSync(SETTINGS, JSON.stringify({ issuer: verdict.issuer }));
}
writeFileSync(VERDICT, `${verdict.door}\n`);
console.log(`Access in front: ${verdict.door}`);

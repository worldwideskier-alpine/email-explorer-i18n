/**
 * Asks every address the deploy reached whether Cloudflare Access stands in
 * front of it, and says what the deploy should do about the Worker's Access
 * settings (accessDoorOf in deployment-check.mjs): `behind`, `open` or
 * `unknown`, written to $RUNNER_TEMP/access-door.txt. When `behind`, the
 * settings to write are in $RUNNER_TEMP/access.json.
 *
 * The addresses are those `wrangler deploy` reported (see
 * check-deployment.mjs) and PRODUCTION_URL. Each is asked for its page and
 * for an API path, as a browser asks, without following a redirect: an
 * Access application can cover a path rather than a whole host. Each found
 * behind Access is then asked for its page as the dashboard asks from
 * script, and only the kind of address, the status and whether it names the
 * team are printed -- with a warning when it does not. None of the
 * addresses and not the team is printed: each is masked before anything
 * else, since this repository's logs are public.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	accessDoorOf,
	addressKind,
	askAccessDoor,
	DASHBOARD_ASK,
	dashboardAskLine,
	dashboardAskReachesTheTeam,
	dashboardAskWarning,
	deployedAddresses,
	SETTLE_ATTEMPTS,
	SETTLE_PAUSE_MS,
} from "./deployment-check.mjs";

const TEMP = process.env.RUNNER_TEMP ?? "";
const VERDICT = join(TEMP, "access-door.txt");
const SETTINGS = join(TEMP, "access.json");
const PATHS = ["/", "/api/v1/settings"];
// The edge's minute after the deploy, once for every question below
// (askAccessDoor).
const settleBy = Date.now() + SETTLE_ATTEMPTS * SETTLE_PAUSE_MS;

writeFileSync(VERDICT, "unknown\n");

const output = join(TEMP, "deploy-output.txt");
const reported = existsSync(output)
	? deployedAddresses(readFileSync(output, "utf8"))
	: [];
const bases = [
	...new Set(
		[...reported, process.env.PRODUCTION_URL ?? ""]
			.map((one) => one.trim().replace(/\/+$/, ""))
			.filter(Boolean),
	),
];
const usable = [];
for (const base of bases) {
	try {
		console.log(`::add-mask::${new URL(base).host}`);
		usable.push(base);
	} catch {
		console.log("one address to ask is not a URL; it is left out");
	}
}
if (usable.length === 0) {
	console.log("no address to ask");
	process.exit(0);
}

const answers = [];
const behind = new Set();
for (const base of usable) {
	for (const path of PATHS) {
		const answer = await askAccessDoor(`${base}${path}`, { settleBy });
		answers.push(answer);
		if (answer.door === "behind") behind.add(base);
	}
}
const verdict = accessDoorOf(answers);
if (verdict.door === "behind") {
	writeFileSync(
		SETTINGS,
		JSON.stringify({
			issuer: verdict.issuer,
			...(verdict.audiences.length ? { audiences: verdict.audiences } : {}),
		}),
	);
	console.log(
		verdict.audiences.length
			? `the application is named by the redirect (${verdict.audiences.length})`
			: "the redirect names no application; the Worker learns it from the first token",
	);
}
writeFileSync(VERDICT, `${verdict.door}\n`);
console.log(
	`Access in front: ${verdict.door}${verdict.reason ? ` (${verdict.reason})` : ""}, from ${answers.length} answers`,
);

// And once more, for each address Access stands in front of, as the
// dashboard asks when it comes back to the front with a lapsed Access
// sign-in. What the dashboard does with the answer is its own
// (appUpdate.ts); this says whether that ever happens here, and warns when
// it cannot. An address with no Access in front has nothing to bring back,
// and is not asked.
for (const base of usable) {
	if (!behind.has(base)) continue;
	const kind = addressKind(base);
	try {
		const response = await fetch(`${base}/`, {
			...DASHBOARD_ASK,
			signal: AbortSignal.timeout(15_000),
		});
		await response.body?.cancel();
		const status = response.status;
		const location = response.headers.get("location");
		console.log(dashboardAskLine(kind, status, location, verdict.issuer));
		if (!dashboardAskReachesTheTeam(status, location, verdict.issuer)) {
			console.log(dashboardAskWarning(kind));
		}
	} catch (e) {
		console.log(
			`dashboard-shaped ask (${kind}): the request failed (${e?.cause?.code ?? e?.code ?? e?.name ?? "error"})`,
		);
	}
}

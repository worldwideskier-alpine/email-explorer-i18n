/**
 * Reads what last night's run left in the bucket and fails when it did not
 * end well. See night-check.mjs for why and for the judgement itself.
 *
 * Through Cloudflare's R2 API rather than wrangler, so that nothing but what
 * this file prints reaches the log: the record names mailboxes, and this
 * repository's logs are public. It prints counts and times, never an id.
 *
 * Reads only. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, and the
 * bucket as dev/wrangler.jsonc has it after apply-deployment-config.mjs.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stringValueOf } from "./deployment-config.mjs";
import { judgeNight, nightSummary } from "./night-check.mjs";

const CONFIG = fileURLToPath(new URL("../dev/wrangler.jsonc", import.meta.url));
// A night that carries its backup on is normally done within minutes of the
// cron's fourteen. Twenty more is patience, not hope.
const WAIT_MS = 20 * 60_000;
const PAUSE_MS = 60_000;

const bucket = stringValueOf(readFileSync(CONFIG, "utf8"), "bucket_name");
const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const token = process.env.CLOUDFLARE_API_TOKEN ?? "";
if (!bucket || !account || !token) {
	console.log("::error::the bucket, the account or the token is missing");
	process.exit(1);
}
const base = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects`;

async function ask(url) {
	const response = await fetch(url, {
		headers: { Authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(30_000),
	});
	return response;
}

/** Why the API refused, by its error codes only: its messages may name things. */
async function refusal(response) {
	const body = await response.json().catch(() => ({}));
	const codes = (body.errors ?? []).map((e) => e.code).join(", ");
	return `the R2 API answered ${response.status}${codes ? ` (${codes})` : ""}`;
}

async function readRecord() {
	const response = await ask(
		`${base}/${encodeURIComponent("maintenance/last-run.json")}`,
	);
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(await refusal(response));
	return JSON.parse(await response.text());
}

async function carriedKeys() {
	const response = await ask(
		`${base}?prefix=${encodeURIComponent("backup-carry/")}&per_page=1000`,
	);
	if (!response.ok) throw new Error(await refusal(response));
	const body = await response.json();
	return (body.result ?? []).map((object) => object.key);
}

const until = Date.now() + WAIT_MS;
let record;
let verdict;
try {
	for (;;) {
		record = await readRecord();
		verdict = judgeNight(record, await carriedKeys(), new Date());
		if (!verdict.pending || Date.now() + PAUSE_MS > until) break;
		console.log(`${verdict.pending}; asking again in a minute`);
		await new Promise((done) => setTimeout(done, PAUSE_MS));
	}
} catch (e) {
	console.log(`::error::could not read the night: ${e.message}`);
	process.exit(1);
}

console.log(nightSummary(record));
const trouble = verdict.pending
	? [...verdict.trouble, `${verdict.pending}, and still so after waiting`]
	: verdict.trouble;
for (const line of trouble) console.log(`::error::${line}`);
if (trouble.length > 0) process.exit(1);
console.log("The night ended well.");

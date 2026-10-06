/**
 * Asks GitHub's advisory database about every package pnpm-lock.yaml pins
 * and fails when one has an advisory that should stop a merge. See
 * advisories.mjs for why, and for the judgement.
 *
 * Reads only, with the token Actions gives every job (GITHUB_TOKEN, which
 * the workflow limits to reading): the database is public, and a key made
 * for this would be one more thing a fork has to set up. The token is for
 * the rate limit -- runners share addresses, and the anonymous limit is
 * sixty an hour per address.
 *
 * Prints package names, advisory ids and GitHub's summaries; the log is
 * public, and none of that is anybody's.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	advisoriesUrl,
	batches,
	blocking,
	CONTROL,
	controlProblem,
	controlQuestion,
	describeAdvisory,
	lockedPackages,
	nextPage,
} from "./advisories.mjs";

const LOCK = fileURLToPath(new URL("../../../pnpm-lock.yaml", import.meta.url));
const token = process.env.GITHUB_TOKEN ?? "";
if (!token) {
	console.log("::error::GITHUB_TOKEN is not set");
	process.exit(1);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * One page, tried three times when GitHub or the network falters. A refusal
 * that is not going to change (4xx other than 429) is not tried again.
 */
async function page(url) {
	let last = "";
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			const response = await fetch(url, {
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"User-Agent": "email-explorer-advisories",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (response.ok) {
				return {
					body: await response.json(),
					next: nextPage(response.headers.get("link")),
				};
			}
			last = `GitHub answered ${response.status}`;
			if (response.status < 500 && response.status !== 429) break;
		} catch (e) {
			last = `the request failed: ${e.message}`;
		}
		await sleep(2000 * attempt);
	}
	throw new Error(last);
}

/** Every page of the answer to one question. */
async function ask(url) {
	const found = [];
	for (let next = url; next; ) {
		const { body, next: after } = await page(next);
		if (!Array.isArray(body)) throw new Error("GitHub's answer was not a list");
		found.push(...body);
		next = after;
	}
	return found;
}

try {
	const locked = lockedPackages(readFileSync(LOCK, "utf8"));
	const question = controlQuestion(locked);
	const control = await ask(advisoriesUrl(question, "reviewed"));
	const problem = controlProblem(control);
	if (problem) {
		console.log(`::error::${problem}`);
		process.exit(1);
	}
	console.log(
		`control: GitHub returned the advisories for ${CONTROL.join(" and ")}, asked among ${question.length - CONTROL.length} locked packages (${advisoriesUrl(question, "reviewed").length} characters)`,
	);

	const found = [];
	for (const batch of batches(locked)) {
		for (const type of ["reviewed", "malware"]) {
			found.push(...(await ask(advisoriesUrl(batch, type))));
		}
	}
	const stop = blocking(found);
	console.log(
		`asked about ${locked.length} locked packages: ${found.length} advisories, ${stop.length} high, critical or malware`,
	);
	for (const advisory of stop) {
		console.log(`::error::${describeAdvisory(advisory, locked)}`);
	}
	process.exit(stop.length === 0 ? 0 : 1);
} catch (e) {
	// Fails closed: a check that could not ask has not passed.
	console.log(
		`::error::could not ask GitHub's advisory database: ${e.message}`,
	);
	process.exit(1);
}

/**
 * Whether a package the lockfile pins has an advisory in GitHub's database
 * that should stop a merge: high or critical, or malware.
 *
 * The pre-merge check asks `pnpm audit`, which reads npm's copy of the
 * advisories, and that copy lagged GitHub's: an advisory for sharp was mailed
 * by Dependabot while `pnpm audit` still found nothing, so the check said
 * "no known vulnerabilities" about a lockfile GitHub was warning about.
 * Dependabot reads GitHub's own database, and so does this.
 *
 * A check that asks a service and hears nothing back passes whatever is
 * wrong with the asking -- a parameter the service reads differently, a page
 * it never sent. So every run first asks about two packages known to be
 * vulnerable, among as many of the lockfile's longest names as any other
 * question holds, and goes no further unless both come back
 * (`controlQuestion`, `controlProblem`).
 *
 * No `node:` imports and no network here, so the judgement is tested in the
 * Workers pool; the asking lives in check-advisories.mjs, the split
 * night-check.mjs uses.
 */

/** What an advisory's severity must be to stop a merge, as `pnpm audit --audit-level high`. */
export const BLOCKING = new Set(["high", "critical"]);

/**
 * Packages per question. Each is `name@version` in the query string, and
 * GitHub answers a URL that is too long with 414; the longest fifty in this
 * lockfile came to 2188 characters.
 */
export const BATCH = 50;

/**
 * Two releases with critical advisories that have stood for years: lodash's
 * prototype pollution in 4.17.11 and minimist's in 0.0.8. Two, so the
 * question has the comma-separated shape every real one has -- one package
 * alone would pass a service that read the list as one name.
 */
export const CONTROL = ["lodash@4.17.11", "minimist@0.0.8"];

/**
 * The control question: CONTROL among the longest names the lockfile has,
 * as many as a real question holds. Two packages alone proved the shape but
 * not the size -- a service that answered a long list with nothing would
 * have passed every real question after a control it answered.
 *
 * @param {string[]} locked `name@version` each
 * @returns {string[]}
 */
export function controlQuestion(locked) {
	const longest = [...locked]
		.filter((one) => !CONTROL.includes(one))
		.sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
		.slice(0, BATCH - CONTROL.length);
	return [...longest, ...CONTROL];
}

/**
 * Every `name@version` in the lockfile's `packages:` section, once each.
 * pnpm writes one key per package there -- `'@scope/name@1.2.3':` or
 * `name@1.2.3:` -- whatever depends on it, and nothing else at that depth.
 *
 * @param {string} lock pnpm-lock.yaml
 * @returns {string[]}
 */
export function lockedPackages(lock) {
	const lines = lock.split(/\r?\n/);
	const start = lines.indexOf("packages:");
	if (start < 0) throw new Error("the lockfile has no packages: section");
	const found = new Set();
	for (const line of lines.slice(start + 1)) {
		if (/^\S/.test(line)) break;
		const key = /^ {2}'?((?:@[^@'\s/]+\/)?[^@'\s/]+)@([^'\s():]+)'?:$/.exec(
			line,
		);
		if (key) found.add(`${key[1]}@${key[2]}`);
		else if (/^ {2}\S/.test(line)) {
			// A key this does not read is a package it would not ask about.
			throw new Error(`a lockfile key this does not read: ${line.trim()}`);
		}
	}
	if (found.size === 0) throw new Error("the lockfile names no packages");
	return [...found].sort();
}

/**
 * @template T
 * @param {T[]} list
 * @param {number} size
 * @returns {T[][]}
 */
export function batches(list, size = BATCH) {
	const out = [];
	for (let at = 0; at < list.length; at += size) {
		out.push(list.slice(at, at + size));
	}
	return out;
}

/**
 * The question for one batch: GitHub's global advisories, npm only, those
 * affecting any of `packages` at its version.
 *
 * @param {string[]} packages `name@version` each
 * @param {"reviewed" | "malware"} type
 */
export function advisoriesUrl(packages, type) {
	const affects = packages.map(encodeURIComponent).join(",");
	return `https://api.github.com/advisories?ecosystem=npm&type=${type}&per_page=100&affects=${affects}`;
}

/** The URL GitHub's Link header gives for the next page, or null. */
export function nextPage(link) {
	if (!link) return null;
	for (const part of link.split(",")) {
		const match = /<([^>]+)>;\s*rel="next"/.exec(part);
		if (match) return match[1];
	}
	return null;
}

/**
 * The advisories among `found` that stop a merge: any malware, and any other
 * that is high or critical. A withdrawn one is no advisory.
 *
 * @param {any[]} found as GitHub returns them
 * @returns {any[]} one per GHSA id
 */
export function blocking(found) {
	const byId = new Map();
	for (const advisory of found) {
		if (advisory.withdrawn_at) continue;
		if (advisory.type !== "malware" && !BLOCKING.has(advisory.severity)) {
			continue;
		}
		byId.set(advisory.ghsa_id, advisory);
	}
	return [...byId.values()];
}

/**
 * Why the answer to CONTROL cannot be trusted, or null when it can: each of
 * its packages has to come back with a blocking advisory naming it.
 *
 * @param {any[]} found the answer to CONTROL
 * @returns {string | null}
 */
export function controlProblem(found) {
	const named = new Set(
		blocking(found).flatMap((advisory) =>
			(advisory.vulnerabilities ?? []).map((v) => v.package?.name),
		),
	);
	const missing = CONTROL.map((one) =>
		one.slice(0, one.lastIndexOf("@")),
	).filter((name) => !named.has(name));
	return missing.length === 0
		? null
		: `asked about ${CONTROL.join(" and ")} among ${BATCH - CONTROL.length} locked packages, GitHub returned no blocking advisory for ${missing.join(" and ")}, which have critical ones; a clean answer below would mean nothing`;
}

/**
 * One line for an advisory, naming the locked packages it is about. Package
 * names and GitHub's summary only: this goes into a public log.
 *
 * @param {any} advisory
 * @param {string[]} locked `name@version` each
 */
export function describeAdvisory(advisory, locked) {
	const names = new Set(
		(advisory.vulnerabilities ?? []).map((v) => v.package?.name),
	);
	const ours = locked.filter((one) =>
		names.has(one.slice(0, one.lastIndexOf("@"))),
	);
	const kind = advisory.type === "malware" ? "malware" : advisory.severity;
	return `${advisory.ghsa_id} (${kind}) ${ours.join(", ") || "?"}: ${advisory.summary ?? ""}`;
}

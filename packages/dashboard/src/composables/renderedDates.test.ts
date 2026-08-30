import { describe, expect, it } from "vitest";

/**
 * No view puts a stored date on screen without formatting it.
 *
 * Every date in this application is stored as an ISO 8601 string in UTC, so
 * `{{ email.date }}` renders `2026-08-30T18:46:35.184Z` -- which is what the
 * mailbox list, the message view and the search results all did, in all 69
 * languages, until useDateFormat. Nothing catches that: it type-checks, it
 * builds, and a test of the views' behaviour passes with a machine-readable
 * timestamp on screen just as happily as with a readable one.
 *
 * The hardcoded-locale check is the other half. Admin.vue asked Intl for
 * `en-US` by name, so account dates came out American in every language --
 * translated correctly, formatted for somewhere else.
 *
 * Sources come from import.meta.glob rather than node:fs, for the reason
 * formContrast.test.ts documents: src/ is type-checked without Node types.
 */

const sources: Record<string, string> = {
	...(import.meta.glob("../views/*.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>),
	...(import.meta.glob("../components/*.vue", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>),
};

/** `{{ email.date }}`, `{{ thing.createdAt }}` and the like, unwrapped. */
const RAW_DATE_INTERPOLATION =
	/\{\{\s*[\w.?]*\b(date|createdAt|updatedAt|expiresAt|uploadedAt|lastRunAt)\b\s*\}\}/g;

/** `toLocaleDateString("en-US")`, `Intl.DateTimeFormat('de')` and friends. */
const HARDCODED_LOCALE =
	/(?:toLocale(?:Date|Time)?String|Intl\.DateTimeFormat)\s*\(\s*["'][a-z]{2}\b/g;

describe("rendered dates", () => {
	it("has sources to check", () => {
		// A glob that silently matched nothing would make this vacuous.
		expect(Object.keys(sources).length).toBeGreaterThan(20);
	});

	it("never interpolates a stored date straight into the template", () => {
		const offenders: string[] = [];
		for (const [path, source] of Object.entries(sources)) {
			for (const match of source.matchAll(RAW_DATE_INTERPOLATION)) {
				const line = source.slice(0, match.index ?? 0).split("\n").length;
				offenders.push(`${path}:${line} ${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	it("never names a locale, so the reader's choice decides", () => {
		const offenders: string[] = [];
		for (const [path, source] of Object.entries(sources)) {
			for (const match of source.matchAll(HARDCODED_LOCALE)) {
				const line = source.slice(0, match.index ?? 0).split("\n").length;
				offenders.push(`${path}:${line} ${match[0]}`);
			}
		}
		expect(offenders).toEqual([]);
	});
});

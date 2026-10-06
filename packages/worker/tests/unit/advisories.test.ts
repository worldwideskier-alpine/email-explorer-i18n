import { describe, expect, it } from "vitest";
import LOCK from "../../../../pnpm-lock.yaml?raw";
// Plain JS on purpose: it runs under node from the deploy workflow.
import {
	advisoriesUrl,
	BATCH,
	batches,
	blocking,
	CONTROL,
	controlProblem,
	controlQuestion,
	describeAdvisory,
	lockedPackages,
	nextPage,
} from "../../scripts/advisories.mjs";

/**
 * The judgement half of the advisory check in CI (check-advisories.mjs asks
 * GitHub). What it must not do is pass quietly: on a lockfile it misreads,
 * on an answer that leaves things out, or on advisories it should count.
 */

const advisory = (
	ghsa: string,
	severity: string,
	names: string[],
	extra: Record<string, unknown> = {},
) => ({
	ghsa_id: ghsa,
	type: "reviewed",
	severity,
	summary: `about ${names.join(", ")}`,
	withdrawn_at: null,
	vulnerabilities: names.map((name) => ({
		package: { ecosystem: "npm", name },
	})),
	...extra,
});

describe("reading the lockfile", () => {
	it("reads every key of this repository's lockfile", () => {
		const keys = LOCK.slice(
			LOCK.indexOf("\npackages:\n"),
			LOCK.indexOf("\nsnapshots:\n"),
		)
			.split("\n")
			.filter((line) => /^ {2}\S/.test(line));
		const locked = lockedPackages(LOCK);
		expect(keys.length).toBeGreaterThan(100);
		expect(locked).toHaveLength(keys.length);
		for (const one of locked) expect(one).toMatch(/^(@[^/]+\/)?[^@/]+@\d/);
	});

	it("reads scoped and plain names, quoted or not, and nothing else", () => {
		const lock = [
			"lockfileVersion: '9.0'",
			"importers:",
			"  .:",
			"    dependencies:",
			"      hono:",
			"        specifier: ^4",
			"packages:",
			"  '@scope/name@1.2.3':",
			"    resolution: {integrity: sha512-x}",
			"  plain@4.5.6-rc.1:",
			"    resolution: {integrity: sha512-y}",
			"  plain@4.5.6-rc.1:",
			"snapshots:",
			"  other@9.9.9:",
		].join("\n");
		expect(lockedPackages(lock)).toEqual([
			"@scope/name@1.2.3",
			"plain@4.5.6-rc.1",
		]);
	});

	it.each([
		["no packages section", "lockfileVersion: '9.0'\nimporters:\n"],
		["an empty one", "packages:\n\nsnapshots:\n"],
		[
			"a key it cannot read beside one it can",
			"packages:\n  ok@1.0.0:\n  thing@file:../thing:\n",
		],
	])("refuses a lockfile with %s rather than ask about nothing", (_, lock) => {
		expect(() => lockedPackages(lock)).toThrow();
	});
});

describe("asking", () => {
	it("asks about every package once, in batches GitHub takes", () => {
		const list = Array.from({ length: 123 }, (_, i) => `p${i}@1.0.0`);
		const parts = batches(list);
		expect(parts.map((part) => part.length)).toEqual([
			BATCH,
			BATCH,
			123 - 2 * BATCH,
		]);
		expect(parts.flat()).toEqual(list);
	});

	it("asks npm's advisories about each package at its version", () => {
		const url = new URL(
			advisoriesUrl(["@scope/a@1.0.0", "b@2.0.0"], "malware"),
		);
		expect(url.origin + url.pathname).toBe("https://api.github.com/advisories");
		expect(url.searchParams.get("ecosystem")).toBe("npm");
		expect(url.searchParams.get("type")).toBe("malware");
		expect(url.searchParams.get("per_page")).toBe("100");
		expect(url.searchParams.get("affects")).toBe("@scope/a@1.0.0,b@2.0.0");
	});

	it("follows GitHub's Link header to the next page, and stops at the last", () => {
		expect(
			nextPage(
				'<https://api.github.com/advisories?after=X>; rel="next", <https://api.github.com/advisories?before=Y>; rel="prev"',
			),
		).toBe("https://api.github.com/advisories?after=X");
		expect(
			nextPage('<https://api.github.com/advisories?before=Y>; rel="prev"'),
		).toBeNull();
		expect(nextPage(null)).toBeNull();
	});
});

describe("what stops a merge", () => {
	it("counts high, critical and malware once each, and nothing else", () => {
		const found = [
			advisory("GHSA-high", "high", ["a"]),
			advisory("GHSA-critical", "critical", ["b"]),
			advisory("GHSA-critical", "critical", ["b"]),
			advisory("GHSA-moderate", "medium", ["c"]),
			advisory("GHSA-low", "low", ["d"]),
			advisory("GHSA-malware", "unknown", ["e"], { type: "malware" }),
			advisory("GHSA-withdrawn", "critical", ["f"], {
				withdrawn_at: "2026-01-01T00:00:00Z",
			}),
		];
		expect(
			blocking(found)
				.map((a) => a.ghsa_id)
				.sort(),
		).toEqual(["GHSA-critical", "GHSA-high", "GHSA-malware"]);
	});

	it("names the locked packages an advisory is about, and nobody's anything", () => {
		const line = describeAdvisory(advisory("GHSA-x", "high", ["sharp"]), [
			"semver@7.0.0",
			"sharp@0.35.4",
		]);
		expect(line).toBe("GHSA-x (high) sharp@0.35.4: about sharp");
	});
});

describe("the control question", () => {
	const names = CONTROL.map((one) => one.slice(0, one.lastIndexOf("@")));

	it("asks about two packages, so it has the shape of every real question", () => {
		expect(CONTROL).toHaveLength(2);
		expect(advisoriesUrl(CONTROL, "reviewed")).toContain(
			"affects=lodash%404.17.11,minimist%400.0.8",
		);
	});

	it("is as long as the longest real question, with the two among them", () => {
		const locked = lockedPackages(LOCK);
		const question = controlQuestion(locked);
		expect(question).toHaveLength(BATCH);
		expect(question).toEqual(expect.arrayContaining(CONTROL));
		const longestReal = Math.max(
			...batches(locked).map((one) => advisoriesUrl(one, "reviewed").length),
		);
		expect(advisoriesUrl(question, "reviewed").length).toBeGreaterThanOrEqual(
			longestReal,
		);
	});

	it("is trusted only when each package comes back with a blocking advisory", () => {
		expect(
			controlProblem([
				advisory("GHSA-1", "critical", [names[0]]),
				advisory("GHSA-2", "critical", [names[1]]),
				advisory("GHSA-3", "low", ["other"]),
			]),
		).toBeNull();
	});

	it.each([
		["nothing", []],
		["one of the two", [advisory("GHSA-1", "critical", ["lodash"])]],
		[
			"the two at a severity that would not count",
			[
				advisory("GHSA-1", "low", ["lodash"]),
				advisory("GHSA-2", "medium", ["minimist"]),
			],
		],
		[
			"the two withdrawn",
			[
				advisory("GHSA-1", "critical", ["lodash"], { withdrawn_at: "x" }),
				advisory("GHSA-2", "critical", ["minimist"], { withdrawn_at: "x" }),
			],
		],
		[
			"advisories about other packages",
			[
				advisory("GHSA-1", "critical", ["a"]),
				advisory("GHSA-2", "critical", ["b"]),
			],
		],
	])("is not trusted when GitHub returns %s", (_, found) => {
		expect(controlProblem(found)).toMatch(/returned no blocking advisory for/);
	});
});

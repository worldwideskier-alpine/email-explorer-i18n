import { describe, expect, it } from "vitest";
import { LOCALES } from "./registry";

/**
 * docs/readme/ holds one short summary per language the picker offers.
 *
 * These are summaries, not translations of the README: keeping 69 full
 * translations current is not realistic, and a stale translation is worse
 * than a short accurate one.
 *
 * The reason this is a test rather than a note: the summaries live far from
 * the catalogue that decides which languages exist, so adding a language and
 * forgetting the summary is the obvious way for this to rot. Nothing at build
 * time would notice -- the docs are not compiled, and the deploy workflow
 * skips runs that only touch docs/**.
 *
 * The docs are read through import.meta.glob rather than node:fs because
 * `type-check` builds this file against @vue/tsconfig's DOM config, which has
 * no node types; node:fs type-checks locally under vitest and then fails the
 * build. Globbing is also what messages.test.ts already does.
 */

const docs = import.meta.glob<string>("../../../../docs/readme/*.md", {
	query: "?raw",
	import: "default",
	eager: true,
});

const nameOf = (path: string) =>
	(path.split("/").pop() as string).replace(/\.md$/, "");

const byCode = new Map(
	Object.entries(docs)
		.map(([path, text]) => [nameOf(path), text] as const)
		.filter(([name]) => name !== "README"),
);

const index = Object.entries(docs).find(
	([path]) => nameOf(path) === "README",
)?.[1];

describe("per-language README summaries", () => {
	it("has a summary for every language the picker offers, and no others", () => {
		const advertised = LOCALES.map((entry) => entry.code).sort();
		expect([...byCode.keys()].sort()).toEqual(advertised);
	});

	it("lists every language in the index", () => {
		expect(index).toBeTypeOf("string");
		const missing = LOCALES.filter(
			(entry) => !(index as string).includes(`(${entry.code}.md)`),
		).map((entry) => entry.code);
		expect(missing).toEqual([]);
	});

	it("names each language in its own language and links back to the README", () => {
		const problems: string[] = [];
		for (const entry of LOCALES) {
			const text = byCode.get(entry.code);
			if (text === undefined) {
				problems.push(`${entry.code}: no summary`);
				continue;
			}
			if (!text.includes(entry.label)) {
				problems.push(`${entry.code}: heading does not carry ${entry.label}`);
			}
			if (!text.includes("../../README.md")) {
				problems.push(`${entry.code}: no link back to the README`);
			}
		}
		expect(problems).toEqual([]);
	});
});

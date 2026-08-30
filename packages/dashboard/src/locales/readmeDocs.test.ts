import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCALES } from "./registry";

/**
 * docs/readme/ holds one short summary per language the picker offers.
 *
 * These are summaries, not translations of the README: keeping 46 full
 * translations current is not realistic, and a stale translation is worse
 * than a short accurate one.
 *
 * The reason this is a test rather than a note: the summaries live far from
 * the catalogue that decides which languages exist, so adding a language and
 * forgetting the summary is the obvious way for this to rot. Nothing at build
 * time would notice -- the docs are not compiled, and the deploy workflow
 * skips runs that only touch docs/**.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS = join(HERE, "..", "..", "..", "..", "docs", "readme");

const summaries = readdirSync(DOCS)
	.filter((name) => name.endsWith(".md") && name !== "README.md")
	.map((name) => name.replace(/\.md$/, ""));

describe("per-language README summaries", () => {
	it("has a summary for every language the picker offers, and no others", () => {
		const advertised = LOCALES.map((entry) => entry.code).sort();
		expect([...summaries].sort()).toEqual(advertised);
	});

	it("lists every language in the index", () => {
		const index = readFileSync(join(DOCS, "README.md"), "utf8");
		const missing = LOCALES.filter(
			(entry) => !index.includes(`(${entry.code}.md)`),
		).map((entry) => entry.code);
		expect(missing).toEqual([]);
	});

	it("names each language in its own language and links back to the README", () => {
		const problems: string[] = [];
		for (const entry of LOCALES) {
			const text = readFileSync(join(DOCS, `${entry.code}.md`), "utf8");
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

import { describe, expect, it } from "vitest";

/**
 * No message may be stored as an already-translated string.
 *
 * `t("...")` returns a plain string. Writing that into a ref freezes it at
 * whichever language was current, so the line stays behind when the language
 * changes while every `t(...)` around it in the template follows. The bug is
 * invisible to a build, a type-check and every other test: the string is
 * correct, and only a language switch while it is on screen reveals it.
 *
 * The fix is `useLocalizedMessage`, which stores how to produce the message
 * and produces it inside a computed. This test is what stops the old shape
 * coming back the next time someone adds a confirmation line.
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
	...(import.meta.glob("../stores/*.ts", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>),
	...(import.meta.glob("../composables/*.ts", {
		query: "?raw",
		import: "default",
		eager: true,
	}) as Record<string, string>),
};

/**
 * Any `x.value = ...` whose right-hand side calls a translator.
 *
 * Deliberately not anchored to the call sitting right after the `=`: the
 * first version of this test was, and it missed
 * `pushError.value = e.message || t("settings.pushError")` -- a message that
 * falls back to a translation is frozen exactly like one that is nothing but
 * a translation. The whole assignment is read, up to its semicolon.
 *
 * `=>` anywhere in the assignment exempts it: that is a producer, which is
 * the shape being asked for.
 */
const ASSIGNMENT = /\.value\s*=(?![=>])\s*[^;]*;/g;
const TRANSLATOR = /\b(?:t|translateApiError|i18n\.global\.t)\s*\(/;

/**
 * Comments are stripped before scanning, so a doc comment that shows the
 * shape it is warning about does not report itself.
 */
function withoutComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("stored messages", () => {
	it("has sources to check", () => {
		// A glob that silently matched nothing would make this test vacuous.
		expect(Object.keys(sources).length).toBeGreaterThan(20);
	});

	it("never writes a translated string into a ref", () => {
		const offenders: string[] = [];

		for (const [path, raw] of Object.entries(sources)) {
			const source = withoutComments(raw);
			for (const match of source.matchAll(ASSIGNMENT)) {
				const assignment = match[0];
				if (assignment.includes("=>")) continue;
				if (!TRANSLATOR.test(assignment)) continue;
				const line = source.slice(0, match.index ?? 0).split("\n").length;
				offenders.push(`${path}:${line} ${assignment.replace(/\s+/g, " ")}`);
			}
		}

		expect(offenders).toEqual([]);
	});
});

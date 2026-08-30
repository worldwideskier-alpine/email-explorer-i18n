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
 * `x.value = t(...)` and `x.value = translateApiError(...)`, across a line
 * break, but not `x.value = () => t(...)`, which is the shape being asked for.
 */
const STORED_TRANSLATION =
	/\.value\s*=\s*(?:t|translateApiError|i18n\.global\.t)\s*\(/g;

describe("stored messages", () => {
	it("has sources to check", () => {
		// A glob that silently matched nothing would make this test vacuous.
		expect(Object.keys(sources).length).toBeGreaterThan(20);
	});

	it("never writes a translated string into a ref", () => {
		const offenders: string[] = [];

		for (const [path, source] of Object.entries(sources)) {
			for (const match of source.matchAll(STORED_TRANSLATION)) {
				const upTo = source.slice(0, match.index ?? 0);
				const line = upTo.split("\n").length;
				offenders.push(`${path}:${line} ${match[0]}`);
			}
		}

		expect(offenders).toEqual([]);
	});
});

import { describe, expect, it } from "vitest";
import { LOCALES } from "./registry";

/**
 * The Worker keeps its own list of the languages it will write mail in, and
 * the two lists have to be the same set.
 *
 * They are not the same file because the Worker cannot import dashboard
 * source: it is a separate package with a separate build. But the dashboard
 * sends whichever locale it is displaying, and the Worker validates the
 * request against its own list with `z.enum`, so a code the picker offers and
 * the Worker has never heard of is not a fallback -- it is a 400 with no mail
 * sent. That is exactly what happened when the picker went to 69 languages and
 * this list stayed at three: "forgot password" was dead in 66 of them, and
 * silently, because the page shows the same "if that address has an account"
 * either way.
 *
 * The Worker file is read as text rather than imported because it lives
 * outside this package's tsconfig; import.meta.glob is the same trick
 * readmeDocs.test.ts uses to stay off node:fs.
 */

const sources = import.meta.glob<string>(
	"../../../worker/src/mail-templates.ts",
	{ query: "?raw", import: "default", eager: true },
);

const source = Object.values(sources)[0];

function mailLocales(text: string): string[] {
	const block = text.match(
		/export const MAIL_LOCALES = \[([\s\S]*?)\] as const;/,
	);
	if (!block) return [];
	return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("Worker mail locales", () => {
	it("reads the Worker's list", () => {
		expect(source).toBeTypeOf("string");
		expect(mailLocales(source).length).toBeGreaterThan(0);
	});

	it("offers mail in exactly the languages the picker offers", () => {
		expect(mailLocales(source).slice().sort()).toEqual(
			LOCALES.map((entry) => entry.code)
				.slice()
				.sort(),
		);
	});
});

import { describe, expect, it } from "vitest";
import { createI18n } from "vue-i18n";
import de from "./de.json";
import en from "./en.json";
import ja from "./ja.json";

/**
 * Every message in the catalogues has to compile.
 *
 * vue-i18n compiles a message the first time it is asked for, not at build
 * time, so a malformed one is a runtime error inside whichever component
 * renders it -- and it takes that whole component down. An example address in
 * a placeholder ("recipient@example.com") did exactly this: "@" opens a linked
 * key in the message syntax, so the compose dialog threw on open and never
 * appeared, while the build, the type check and every other test stayed green.
 *
 * Asking for each key is the check: compilation is what throws.
 */

const catalogues = { ja, en, de } as const;

function leafKeys(node: unknown, prefix = ""): string[] {
	if (typeof node === "string") return [prefix];
	if (node && typeof node === "object") {
		return Object.entries(node).flatMap(([key, value]) =>
			leafKeys(value, prefix ? `${prefix}.${key}` : key),
		);
	}
	return [];
}

describe("locale catalogues", () => {
	for (const [locale, messages] of Object.entries(catalogues)) {
		it(`compiles every message in ${locale}`, () => {
			const i18n = createI18n({
				legacy: false,
				locale,
				// No fallback: a broken message must surface here rather than be
				// quietly served from another locale.
				fallbackLocale: locale,
				messages: { [locale]: messages },
			});
			const t = i18n.global.t as (key: string) => string;

			const failures: string[] = [];
			for (const key of leafKeys(messages)) {
				try {
					t(key);
				} catch (e) {
					failures.push(`${key}: ${(e as Error).message}`);
				}
			}

			expect(failures).toEqual([]);
		});
	}

	it("keeps the three catalogues on the same set of keys", () => {
		const jaKeys = leafKeys(ja).sort();
		expect(leafKeys(en).sort()).toEqual(jaKeys);
		expect(leafKeys(de).sort()).toEqual(jaKeys);
	});
});

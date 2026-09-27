/**
 * The real English catalogue with a test's own strings laid over it.
 *
 * A screen mounted with only the handful of messages its test asserts on
 * asks for dozens more while it renders, and vue-i18n warns once for each.
 * A hundred such lines in every run buried the few that meant something.
 * Only tests import this; the app loads catalogues itself (see i18n.ts).
 */

type Messages = { [key: string]: string | Messages };

const en = Object.values(
	import.meta.glob("../locales/en.json", {
		import: "default",
		eager: true,
	}) as Record<string, Messages>,
)[0] as Messages;

function merge(base: Messages, over: Messages): Messages {
	const out: Messages = { ...base };
	for (const [key, value] of Object.entries(over)) {
		const under = out[key];
		out[key] =
			typeof value === "object" && typeof under === "object"
				? merge(under, value)
				: value;
	}
	return out;
}

export function englishWith(overrides: Messages = {}): Messages {
	return merge(en, overrides);
}

import { useI18n } from "vue-i18n";

/**
 * Dates written the way the reader's language writes them.
 *
 * Every date in this application is stored as an ISO 8601 string in UTC
 * (`new Date().toISOString()` on every path -- received, sent, draft, reply,
 * import). The three views that show a message printed that string straight
 * out, so the mailbox list read `2026-08-30T18:46:35.184Z` in all 69
 * languages, and Admin.vue asked for `en-US` by name, so account dates came
 * out American whatever language was chosen.
 *
 * Formatting here also moves the time into the reader's own zone, which the
 * stored `Z` never was.
 *
 * `t()`-style reactivity applies: `locale` is read inside the returned
 * functions, so a component that calls them from a computed or a template
 * re-renders on a language change. Calling one and storing the result in a
 * ref would freeze it -- see useLocalizedMessage for why.
 */

/**
 * Not every code in the registry is one Intl knows: `fil`, `yue` and the
 * script-tagged Chinese codes are accepted by modern browsers, but a browser
 * that does not know one throws RangeError rather than falling back. Cache
 * the resolved formatter per locale-and-shape, because constructing one is
 * the expensive part and a list rebuilds this on every render.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
	locale: string,
	options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
	const cacheKey = `${locale}|${JSON.stringify(options)}`;
	const cached = formatters.get(cacheKey);
	if (cached) return cached;

	let made: Intl.DateTimeFormat;
	try {
		made = new Intl.DateTimeFormat(locale, options);
	} catch {
		// An unknown language is still better served by the browser's own
		// default than by the ISO string.
		made = new Intl.DateTimeFormat(undefined, options);
	}
	formatters.set(cacheKey, made);
	return made;
}

/**
 * A date that cannot be parsed is shown as it was stored rather than as
 * "Invalid Date": whatever is in there is at least evidence of what went
 * wrong, and this is not the place to lose it.
 */
function parse(value: string | number | null | undefined): Date | null {
	if (value === null || value === undefined || value === "") return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

export function useDateFormat() {
	const { locale } = useI18n();

	/**
	 * For a list, where the column is narrow and the year is usually now:
	 * today shows the time, anything older shows the date. That is what mail
	 * clients do, and it is what makes a column of dates scannable.
	 */
	const formatListDate = (value: string | number | null | undefined) => {
		const date = parse(value);
		if (!date) return String(value ?? "");

		const now = new Date();
		const sameDay =
			date.getFullYear() === now.getFullYear() &&
			date.getMonth() === now.getMonth() &&
			date.getDate() === now.getDate();

		return formatter(
			locale.value,
			sameDay ? { timeStyle: "short" } : { dateStyle: "short" },
		).format(date);
	};

	/** For a single message, where there is room to be unambiguous. */
	const formatFullDate = (value: string | number | null | undefined) => {
		const date = parse(value);
		if (!date) return String(value ?? "");
		return formatter(locale.value, {
			dateStyle: "medium",
			timeStyle: "short",
		}).format(date);
	};

	/** For a date with no meaningful time of day, such as a sign-up day. */
	const formatDay = (value: string | number | null | undefined) => {
		const date = parse(value);
		if (!date) return String(value ?? "");
		return formatter(locale.value, { dateStyle: "medium" }).format(date);
	};

	return { formatListDate, formatFullDate, formatDay };
}

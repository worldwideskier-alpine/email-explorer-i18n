import { computed, shallowRef, type WritableComputedRef } from "vue";

/**
 * A message that follows the language.
 *
 * `t("...")` returns a plain string, so a ref holding its result is frozen at
 * whichever language was current when it was written. Every label around it is
 * `t(...)` called from the template, which re-renders on a language change, so
 * the one stored line stays behind in the old language while the rest of the
 * screen moves -- and these are exactly the lines that stay on screen long
 * enough for someone to switch languages while reading them: a save
 * confirmation, an error, "it has not run yet".
 *
 * This holds *how* to produce the message rather than the message, and
 * produces it inside a computed, so the language is read at render time like
 * everywhere else.
 *
 * The setter takes either a producer or a plain string, so `msg.value = ""`
 * and `msg.value = null` still clear it and the templates that read
 * `v-if="msg"` and `{{ msg }}` are unchanged. Assign a producer whenever the
 * text comes from `t()`:
 *
 *     const message = useLocalizedMessage();
 *     message.value = () => t("settings.autoBackupSaved");
 *     message.value = "";
 *
 * A plain string is for text that is not translated in the first place, such
 * as a message quoted verbatim from the API.
 */
export type MessageSource = (() => string) | string | null | undefined;

export function useLocalizedMessage(): WritableComputedRef<
	string,
	MessageSource
> {
	const produce = shallowRef<(() => string) | null>(null);

	return computed<string, MessageSource>({
		get: () => produce.value?.() ?? "",
		set: (source) => {
			if (typeof source === "function") produce.value = source;
			else if (source) produce.value = () => source;
			else produce.value = null;
		},
	});
}

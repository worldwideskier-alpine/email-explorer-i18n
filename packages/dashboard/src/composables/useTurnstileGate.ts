import { computed, ref } from "vue";
import { useAppSettings } from "@/composables/useAppSettings";

/**
 * What a form a stranger can reach needs for Turnstile: whether to show the
 * widget, its current token, and whether the form may be sent yet.
 *
 * A token passes once, so every send spends it and the widget is reset for
 * the next. A refusal for want of one also re-reads the settings: a page
 * loaded before root turned Turnstile on shows no widget, and without this it
 * would go on failing until somebody reloaded it.
 */
export function useTurnstileGate() {
	const { turnstileSiteKey, fetchSettings } = useAppSettings();
	const siteKey = computed(() => turnstileSiteKey());
	const token = ref<string | null>(null);
	const widget = ref<{ reset(): void } | null>(null);
	const ready = computed(() => !siteKey.value || Boolean(token.value));

	function spent(error?: unknown) {
		token.value = null;
		widget.value?.reset();
		const fromApi = (error as { response?: { data?: { error?: string } } })
			?.response?.data?.error;
		if (fromApi === "Bot check failed") void fetchSettings();
	}

	return {
		siteKey,
		token,
		widget,
		ready,
		spent,
		/** The token to send, or undefined when Turnstile is off. */
		current: () => (siteKey.value ? (token.value ?? undefined) : undefined),
	};
}

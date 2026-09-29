<template>
	<div>
		<div ref="container" class="flex justify-center"></div>
		<p v-if="failure" class="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
			{{ t("turnstile.failed", { code: failure }) }}
		</p>
	</div>
</template>

<script setup lang="ts">
/**
 * Turnstile's widget, rendered with the site key it is given.
 *
 * Emits the token when there is one and null when there stops being one
 * (expired, reset, failed): a token passes siteverify once, so whoever sends
 * it resets the widget afterwards to get the next.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { loadTurnstile, type TurnstileApi } from "@/services/turnstile";

const props = defineProps<{ siteKey: string }>();
const emit = defineEmits<{
	token: [token: string | null];
	failed: [code: string];
}>();
const { t } = useI18n();

const container = ref<HTMLElement | null>(null);
const failure = ref("");
let api: TurnstileApi | null = null;
let widgetId: string | undefined;
let unmounted = false;

function remove() {
	if (api && widgetId !== undefined) api.remove(widgetId);
	widgetId = undefined;
}

async function render() {
	remove();
	failure.value = "";
	emit("token", null);
	try {
		api = await loadTurnstile();
	} catch {
		failure.value = "script";
		emit("failed", "script");
		return;
	}
	if (unmounted || !container.value) return;
	try {
		widgetId = renderInto(api, container.value);
	} catch {
		// Turnstile throws rather than calling error-callback for a site key
		// it cannot even read -- an address a browser filled in, say -- and
		// the check then sat on "waiting" for good.
		failure.value = "sitekey";
		emit("failed", "sitekey");
	}
}

function renderInto(api: TurnstileApi, container: HTMLElement) {
	return api.render(container, {
		sitekey: props.siteKey,
		theme: "auto",
		// The normal widget is 300px wide, which is wider than a form on a
		// 320px screen once the page's margins are taken off.
		size: window.matchMedia?.("(max-width: 359px)").matches
			? "compact"
			: "normal",
		callback: (token) => {
			failure.value = "";
			emit("token", token);
		},
		"expired-callback": () => emit("token", null),
		"error-callback": (code) => {
			failure.value = String(code);
			emit("token", null);
			emit("failed", String(code));
			return true;
		},
	});
}

/** A fresh token, after the last one was spent. */
function reset() {
	emit("token", null);
	if (api && widgetId !== undefined) api.reset(widgetId);
}
defineExpose({ reset });

onMounted(render);
watch(() => props.siteKey, render);
onBeforeUnmount(() => {
	unmounted = true;
	remove();
});
</script>

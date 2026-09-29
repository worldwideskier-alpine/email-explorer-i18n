<template>
	<div class="bg-white dark:bg-gray-800 rounded-xl shadow p-6 border border-gray-200 dark:border-gray-700">
		<h2 class="text-lg font-medium text-gray-900 dark:text-white">{{ t("root.turnstile.title") }}</h2>
		<p v-if="stored" class="mt-3 text-sm">
			<span class="text-gray-600 dark:text-gray-400 mr-2">{{ t("root.turnstile.statusLabel") }}</span>
			<span
				v-if="stored.siteKey"
				class="text-green-700 dark:text-green-400 break-all"
			>{{ t("root.turnstile.on", { siteKey: stored.siteKey, secret: stored.secretKey ?? "" }) }}</span>
			<span v-else class="text-gray-700 dark:text-gray-300">{{ t("root.turnstile.off") }}</span>
		</p>
		<p class="text-sm text-gray-600 dark:text-gray-400 mt-2">{{ t("root.turnstile.description") }}</p>

		<!-- Arrives with the stored site key filled in; writing only once typed
		     into. See Root.vue's recoveryTouched.

		     No field here is type=password, and that is what keeps password
		     managers out: with one, the browser took the pair for a sign-in
		     form and put root's own address and password in as the keys, and
		     would have offered to save the secret as a password. The secret is
		     masked by CSS instead. The data-*ignore attributes are for the
		     managers that look at more than the type. -->
		<form
			@submit.prevent="save"
			@input="touched = true"
			:data-not-writing="touched ? undefined : ''"
			class="mt-4"
		>
			<div class="grid gap-3 sm:grid-cols-2">
				<div class="min-w-0">
					<label for="turnstileSiteKey" class="block text-sm text-gray-700 dark:text-gray-300 mb-1">{{ t("root.turnstile.siteKey") }}</label>
					<input
						id="turnstileSiteKey"
						v-model="siteKeyInput"
						name="turnstile-site-key"
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
						data-1p-ignore
						data-lpignore="true"
						data-bwignore
						placeholder="0x4AAAA..."
						class="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
					/>
				</div>
				<div class="min-w-0">
					<label for="turnstileSecretKey" class="block text-sm text-gray-700 dark:text-gray-300 mb-1">{{ t("root.turnstile.secretKey") }}</label>
					<input
						id="turnstileSecretKey"
						v-model="secretInput"
						name="turnstile-secret-key"
						autocomplete="off"
						autocapitalize="off"
						spellcheck="false"
						data-1p-ignore
						data-lpignore="true"
						data-bwignore
						placeholder="0x4AAAA..."
						class="[-webkit-text-security:disc] w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
					/>
				</div>
			</div>

			<!-- The check: the widget renders with the typed site key, and its
			     token goes to siteverify with the typed secret. -->
			<div v-if="candidate" class="mt-3">
				<TurnstileWidget
					:key="attempt"
					:site-key="candidate.siteKey"
					@token="onToken"
					@failed="widgetFailed = true"
				/>
			</div>
			<p
				v-if="checkLine"
				class="mt-2 text-sm"
				:class="checkLine.bad ? 'text-red-600 dark:text-red-400' : checkLine.good ? 'text-green-700 dark:text-green-400' : 'text-gray-600 dark:text-gray-400'"
				:role="checkLine.bad ? 'alert' : undefined"
			>{{ checkLine.text }}</p>

			<div class="mt-3 flex flex-wrap gap-2">
				<button
					type="submit"
					:disabled="busy || !canSave"
					class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
				>{{ t("root.turnstile.save") }}</button>
				<button
					v-if="stored?.siteKey"
					type="button"
					@click="remove"
					:disabled="busy"
					class="px-4 py-2 text-sm text-red-700 dark:text-red-300 border border-red-300 dark:border-red-700 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
				>{{ t("root.turnstile.remove") }}</button>
			</div>
		</form>
		<p v-if="message" class="mt-2 text-sm text-green-700 dark:text-green-400">{{ message }}</p>
		<p v-if="error" class="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{{ error }}</p>
	</div>
</template>

<script setup lang="ts">
/**
 * Root's switch for Turnstile on the sign-in, registration and reset forms.
 *
 * A pair is saved only once it has been seen to work, here: the widget has to
 * render with the site key -- which it does not if the hostname is missing
 * from the widget -- and its token has to pass with the secret. A wrong pair
 * saved unchecked would refuse every sign-in, root's with them, and this
 * screen is behind the sign-in. The Worker holds the same rule on its side.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import TurnstileWidget from "@/components/TurnstileWidget.vue";
import { useAppSettings } from "@/composables/useAppSettings";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import api from "@/services/api";
import { translateApiError } from "@/utils/apiError";

const { t } = useI18n();
const { fetchSettings } = useAppSettings();

interface Stored {
	siteKey: string | null;
	secretKey: string | null;
}
interface Pair {
	siteKey: string;
	secretKey: string;
}
type Check =
	| { state: "waiting" }
	| { state: "checking" }
	| { state: "passed" }
	| { state: "failed"; verdict: string; codes: string[] };

/** Typing pauses this long before a pair is tried. */
const SETTLE_MS = 700;

const stored = ref<Stored | null>(null);
const siteKeyInput = ref("");
const secretInput = ref("");
const touched = ref(false);
/** The pair the widget is rendered for, once typing has settled. */
const candidate = ref<Pair | null>(null);
/** Re-renders the widget: a new pair, or a token that has to be replaced. */
const attempt = ref(0);
const check = ref<Check | null>(null);
const widgetFailed = ref(false);
const verified = ref<Pair | null>(null);
const busy = ref(false);
const message = useLocalizedMessage();
const error = useLocalizedMessage();
let settle: ReturnType<typeof setTimeout> | undefined;

const typed = (): Pair => ({
	siteKey: siteKeyInput.value.trim(),
	secretKey: secretInput.value.trim(),
});
const same = (a: Pair | null, b: Pair) =>
	a !== null && a.siteKey === b.siteKey && a.secretKey === b.secretKey;

const canSave = computed(() => same(verified.value, typed()));

watch([siteKeyInput, secretInput], () => {
	clearTimeout(settle);
	const pair = typed();
	if (same(candidate.value, pair)) return;
	candidate.value = null;
	check.value = null;
	widgetFailed.value = false;
	if (!pair.siteKey || !pair.secretKey) return;
	settle = setTimeout(() => tryPair(pair), SETTLE_MS);
});

function tryPair(pair: Pair) {
	candidate.value = pair;
	attempt.value++;
	check.value = { state: "waiting" };
	widgetFailed.value = false;
}

async function onToken(token: string | null) {
	const pair = candidate.value;
	if (!token || !pair) return;
	check.value = { state: "checking" };
	try {
		await api.verifyTurnstile(pair.siteKey, pair.secretKey, token);
		if (!same(candidate.value, pair)) return;
		verified.value = pair;
		check.value = { state: "passed" };
	} catch (e: any) {
		if (!same(candidate.value, pair)) return;
		const data = e?.response?.data ?? {};
		check.value = {
			state: "failed",
			verdict: String(data.verdict ?? "unanswered"),
			codes: Array.isArray(data.codes) ? data.codes.map(String) : [],
		};
	}
}

/** Derived from state, so it follows a change of language. */
const checkLine = computed(() => {
	if (widgetFailed.value) {
		return { text: t("root.turnstile.widgetFailed"), bad: true, good: false };
	}
	const now = check.value;
	if (!now) {
		const pair = typed();
		if (pair.siteKey && pair.secretKey) return null;
		if (!pair.siteKey && !pair.secretKey) return null;
		return { text: t("root.turnstile.enterBoth"), bad: false, good: false };
	}
	if (now.state === "waiting") {
		return { text: t("root.turnstile.waiting"), bad: false, good: false };
	}
	if (now.state === "checking") {
		return { text: t("root.turnstile.checking"), bad: false, good: false };
	}
	if (now.state === "passed") {
		return { text: t("root.turnstile.passed"), bad: false, good: true };
	}
	const why =
		now.verdict === "secret-invalid"
			? t("root.turnstile.badSecret")
			: now.verdict === "unanswered"
				? t("root.turnstile.unanswered")
				: now.codes.includes("invalid-input-response")
					? t("root.turnstile.mismatch")
					: t("root.turnstile.refused", { codes: now.codes.join(", ") });
	return { text: why, bad: true, good: false };
});

async function load() {
	try {
		stored.value = (await api.getTurnstile()).data ?? null;
	} catch {
		stored.value = null;
	}
	// Not over what somebody has already started typing: the answer can
	// arrive after they have.
	if (touched.value) return;
	siteKeyInput.value = stored.value?.siteKey ?? "";
	secretInput.value = "";
}

function settled(now: Stored) {
	stored.value = now;
	siteKeyInput.value = now.siteKey ?? "";
	secretInput.value = "";
	touched.value = false;
	verified.value = null;
	// The sign-in forms of this tab read the public settings; without this
	// they would go on without the widget until the page was reloaded.
	void fetchSettings();
}

async function save() {
	const pair = typed();
	if (!same(verified.value, pair)) return;
	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		settled((await api.setTurnstile(pair.siteKey, pair.secretKey)).data);
		message.value = () => t("root.turnstile.saved");
	} catch (e: any) {
		if (e?.response?.status === 409) {
			// Checked too long ago: check again.
			verified.value = null;
			tryPair(pair);
			error.value = () => t("root.turnstile.notChecked");
		} else {
			const fromApi = e?.response?.data?.error;
			error.value = () =>
				translateApiError(fromApi, t("root.turnstile.failed"));
		}
	} finally {
		busy.value = false;
	}
}

async function remove() {
	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		settled((await api.deleteTurnstile()).data);
		message.value = () => t("root.turnstile.removed");
	} catch (e: any) {
		const fromApi = e?.response?.data?.error;
		error.value = () => translateApiError(fromApi, t("root.turnstile.failed"));
	} finally {
		busy.value = false;
	}
}

onMounted(load);
onBeforeUnmount(() => clearTimeout(settle));
</script>

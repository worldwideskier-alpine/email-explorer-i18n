<template>
	<!-- Outbound mail. Your own key: the one your messages are sent with,
	     and the account they are billed to. The key itself is never sent
	     back here; the API answers only with whether one is set. -->
	<div
		class="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700"
		:class="plain ? 'shadow' : 'shadow-lg'"
	>
		<h2
			class="text-gray-900 dark:text-white mb-1"
			:class="plain ? 'text-lg font-medium' : 'text-xl font-bold'"
		>{{ t("admin.resend.title") }}</h2>
		<p class="text-sm text-gray-600 dark:text-gray-400 mb-4">{{ t("admin.resend.description") }}</p>

		<div class="flex items-center gap-2 mb-3">
			<span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("admin.resend.statusLabel") }}:</span>
			<span
				v-if="source === 'stored'"
				class="px-2 py-0.5 text-xs font-semibold text-green-800 bg-green-100 dark:bg-green-900/40 dark:text-green-300 rounded-full"
			>{{ t("admin.resend.sourceStored") }}</span>
			<span
				v-else-if="source === 'environment'"
				class="px-2 py-0.5 text-xs font-semibold text-amber-800 bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300 rounded-full"
			>{{ t("admin.resend.sourceEnvironment") }}</span>
			<span
				v-else
				class="px-2 py-0.5 text-xs font-semibold text-red-800 bg-red-100 dark:bg-red-900/40 dark:text-red-300 rounded-full"
			>{{ t("admin.resend.sourceNone") }}</span>
		</div>

		<form @submit.prevent="save" class="flex flex-col sm:flex-row gap-2">
			<label for="resendApiKey" class="sr-only">{{ t("admin.resend.title") }}</label>
			<input
				id="resendApiKey"
				type="password"
				v-model="input"
				autocomplete="off"
				:placeholder="t('admin.resend.placeholder')"
				class="flex-grow bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg shadow-sm sm:text-sm p-3"
			/>
			<button
				type="submit"
				:disabled="!input.trim() || saving"
				class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex-shrink-0"
			>
				{{ t("admin.resend.submit") }}
			</button>
			<button
				v-if="source === 'stored'"
				type="button"
				@click="clear"
				:disabled="saving"
				class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 flex-shrink-0"
			>
				{{ t("admin.resend.remove") }}
			</button>
		</form>
		<p v-if="message" class="text-sm text-green-600 dark:text-green-400 mt-2">{{ message }}</p>
		<p v-if="error" class="text-sm text-red-600 dark:text-red-400 mt-2" role="alert">{{ error }}</p>
		<p class="text-xs text-gray-500 dark:text-gray-400 mt-3">{{ t("admin.resend.storageNote") }}</p>
	</div>
</template>

<script setup lang="ts">
/**
 * The signed-in person's own sending key, on whichever screen they manage
 * themselves from: /admin for an administrator, /root for root.
 *
 * Root needed one as much as anybody. Its password reset and its
 * address-change confirmation are root's own mail, sent with root's own key
 * (resend.ts), and root cannot open /admin -- so for as long as this lived
 * only there, root's reset mail could go out only through the deployment-wide
 * key left over from before keys were per person, which no screen showed.
 */
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import api from "@/services/api";

// The card takes the look of the screen it sits on: /admin's cards carry a
// bold heading and a deep shadow, /root's a lighter one of each.
defineProps<{ plain?: boolean }>();

const { t } = useI18n();

const source = ref<"stored" | "environment" | "none">("none");
const input = ref("");
const saving = ref(false);
const message = useLocalizedMessage();
const error = useLocalizedMessage();

onMounted(async () => {
	try {
		source.value = (await api.adminGetResendSettings()).data.source;
	} catch {
		source.value = "none";
	}
});

async function apply(apiKey: string, done: () => string) {
	saving.value = true;
	message.value = "";
	error.value = "";
	try {
		source.value = (await api.adminSetResendApiKey(apiKey)).data.source;
		input.value = "";
		message.value = done;
	} catch {
		error.value = () => t("admin.resend.failed");
	} finally {
		saving.value = false;
	}
}

const save = () => apply(input.value.trim(), () => t("admin.resend.saved"));

function clear() {
	if (!confirm(t("admin.resend.confirmRemove"))) return;
	apply("", () => t("admin.resend.removed"));
}
</script>

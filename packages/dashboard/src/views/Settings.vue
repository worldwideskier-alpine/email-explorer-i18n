<template>
  <div class="bg-white dark:bg-gray-800 shadow-md rounded-lg p-6">
    <h1 class="text-xl font-semibold text-gray-900 dark:text-white mb-6">{{ t("settings.title") }}</h1>
    <div v-if="mailbox">
      <form @submit.prevent="updateSettings" class="space-y-6">
        <div>
          <label for="name" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("settings.name") }}</label>
          <input type="text" id="name" v-model="nameInput" class="mt-1 block w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm p-3" />
        </div>
        <div>
          <label for="email" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("settings.email") }}</label>
          <input type="email" id="email" v-model="mailbox.email" class="mt-1 block w-full bg-gray-200 dark:bg-gray-600 border-gray-300 dark:border-gray-500 text-gray-700 dark:text-gray-300 rounded-md shadow-sm sm:text-sm p-3" disabled />
        </div>

        <!-- Signature Section -->
        <div class="border-t border-gray-200 dark:border-gray-700 pt-6">
          <div class="flex items-center justify-between mb-4">
            <div>
              <h2 class="text-lg font-medium text-gray-900 dark:text-white">{{ t("settings.signatureTitle") }}</h2>
              <p class="text-sm text-gray-500 dark:text-gray-400">{{ t("settings.signatureDescription") }}</p>
            </div>
            <label class="relative inline-flex items-center cursor-pointer">
              <input type="checkbox" v-model="signatureEnabled" class="sr-only peer" />
              <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:after:border-gray-600 peer-checked:bg-indigo-600"></div>
            </label>
          </div>
          <div v-if="signatureEnabled">
            <RichTextEditor v-model="signatureHtml" />
          </div>
        </div>

        <div class="flex justify-end">
          <button type="submit" class="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700">{{ t("settings.save") }}</button>
        </div>
      </form>

      <!-- Push Notifications Section (device-wide, not per-mailbox) -->
      <div v-if="pushSupported" class="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
        <div class="flex items-center justify-between mb-2">
          <div>
            <h2 class="text-lg font-medium text-gray-900 dark:text-white">{{ t("settings.pushTitle") }}</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400">{{ t("settings.pushDescription") }}</p>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" :checked="pushEnabled" :disabled="pushLoading" @change="togglePush" class="sr-only peer" />
            <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:after:border-gray-600 peer-checked:bg-indigo-600 peer-disabled:opacity-50"></div>
          </label>
        </div>
        <p v-if="pushError" class="text-sm text-red-600 dark:text-red-400">{{ pushError }}</p>
      </div>

      <!-- Spam Filter Section (Claude API key, per-mailbox) -->
      <div class="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
        <div class="mb-4">
          <h2 class="text-lg font-medium text-gray-900 dark:text-white">{{ t("settings.spamFilterTitle") }}</h2>
          <p class="text-sm text-gray-500 dark:text-gray-400">{{ t("settings.spamFilterDescription") }}</p>
        </div>
        <div class="flex items-center gap-2 mb-3">
          <span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("settings.spamFilterApiKeyLabel") }}:</span>
          <span v-if="claudeApiKeyConfigured" class="px-2 py-0.5 text-xs font-semibold text-green-800 bg-green-100 dark:bg-green-900/40 dark:text-green-300 rounded-full">
            {{ t("settings.spamFilterApiKeyConfigured") }}
          </span>
          <span v-else class="px-2 py-0.5 text-xs font-semibold text-gray-600 bg-gray-100 dark:bg-gray-700 dark:text-gray-300 rounded-full">
            {{ t("settings.spamFilterApiKeyNotConfigured") }}
          </span>
        </div>
        <form @submit.prevent="saveApiKey" class="flex flex-col sm:flex-row gap-2">
          <input
            type="password"
            v-model="claudeApiKeyInput"
            autocomplete="off"
            :placeholder="claudeApiKeyConfigured ? t('settings.spamFilterApiKeyPlaceholderConfigured') : t('settings.spamFilterApiKeyPlaceholderEmpty')"
            class="flex-grow bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-md shadow-sm focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm p-3"
          />
          <button
            type="submit"
            :disabled="!claudeApiKeyInput.trim() || spamFilterLoading"
            class="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50 flex-shrink-0"
          >
            {{ t("settings.save") }}
          </button>
          <button
            v-if="claudeApiKeyConfigured"
            type="button"
            @click="removeApiKey"
            :disabled="spamFilterLoading"
            class="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 flex-shrink-0"
          >
            {{ t("settings.spamFilterRemove") }}
          </button>
        </form>
        <p v-if="spamFilterMessage" class="text-sm text-green-600 dark:text-green-400 mt-2">{{ spamFilterMessage }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import RichTextEditor from "@/components/RichTextEditor.vue";
import {
	getExistingSubscription,
	isPushSupported,
	subscribeToPush,
	unsubscribeFromPush,
} from "@/services/push";
import { useMailboxStore } from "@/stores/mailboxes";

const { t } = useI18n();
const mailboxStore = useMailboxStore();
const { currentMailbox: mailbox } = storeToRefs(mailboxStore);
const route = useRoute();

const nameInput = ref("");
const signatureEnabled = ref(false);
const signatureHtml = ref("");

const pushSupported = isPushSupported();
const pushEnabled = ref(false);
const pushLoading = ref(false);
const pushError = ref("");

onMounted(async () => {
	if (!pushSupported) return;
	const subscription = await getExistingSubscription();
	pushEnabled.value = !!subscription;
});

const togglePush = async () => {
	pushError.value = "";
	pushLoading.value = true;
	try {
		if (pushEnabled.value) {
			await unsubscribeFromPush();
			pushEnabled.value = false;
		} else {
			await subscribeToPush();
			pushEnabled.value = true;
		}
	} catch (e: any) {
		pushError.value = e.message || t("settings.pushError");
	} finally {
		pushLoading.value = false;
	}
};

// Initialize signature state when mailbox loads
watch(
	mailbox,
	(m) => {
		if (m?.settings?.signature) {
			signatureEnabled.value = m.settings.signature.enabled;
			signatureHtml.value =
				m.settings.signature.html || m.settings.signature.text || "";
		}
	},
	{ immediate: true },
);

// Initialize the display name from settings.fromName -- the actual persisted
// field (see mergeMailboxSettings server-side); mailbox.name is just a
// read-only projection of it, so editing it directly wouldn't persist.
watch(
	mailbox,
	(m) => {
		nameInput.value = m?.settings?.fromName || m?.name || "";
	},
	{ immediate: true },
);

const claudeApiKeyInput = ref("");
const claudeApiKeyConfigured = ref(false);
const spamFilterLoading = ref(false);
const spamFilterMessage = ref("");

watch(
	mailbox,
	(m) => {
		claudeApiKeyConfigured.value =
			!!m?.settings?.spamFilter?.claudeApiKeyConfigured;
	},
	{ immediate: true },
);

onMounted(() => {
	mailboxStore.fetchMailbox(route.params.mailboxId as string);
});

const stripHtml = (html: string): string => {
	const div = document.createElement("div");
	div.innerHTML = html;
	return div.textContent || div.innerText || "";
};

const updateSettings = () => {
	if (mailbox.value) {
		const settings = {
			...mailbox.value.settings,
			fromName: nameInput.value.trim(),
			signature: {
				enabled: signatureEnabled.value,
				text: stripHtml(signatureHtml.value),
				html: signatureHtml.value,
			},
		};
		mailboxStore.updateMailbox(route.params.mailboxId as string, settings);
	}
};

const saveApiKey = async () => {
	if (!mailbox.value || !claudeApiKeyInput.value.trim()) return;
	spamFilterLoading.value = true;
	spamFilterMessage.value = "";
	try {
		const settings = {
			...mailbox.value.settings,
			spamFilter: {
				...mailbox.value.settings?.spamFilter,
				claudeApiKey: claudeApiKeyInput.value.trim(),
			},
		};
		await mailboxStore.updateMailbox(
			route.params.mailboxId as string,
			settings,
		);
		claudeApiKeyInput.value = "";
		spamFilterMessage.value = t("settings.spamFilterSaved");
	} finally {
		spamFilterLoading.value = false;
	}
};

const removeApiKey = async () => {
	if (!mailbox.value) return;
	if (!confirm(t("settings.spamFilterConfirmRemove"))) return;
	spamFilterLoading.value = true;
	spamFilterMessage.value = "";
	try {
		const settings = {
			...mailbox.value.settings,
			spamFilter: {
				...mailbox.value.settings?.spamFilter,
				claudeApiKey: "",
			},
		};
		await mailboxStore.updateMailbox(
			route.params.mailboxId as string,
			settings,
		);
		claudeApiKeyInput.value = "";
	} finally {
		spamFilterLoading.value = false;
	}
};
</script>

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

      <!-- Backup: the only way to get the mail out of this system -->
      <div class="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
        <h2 class="text-lg font-medium text-gray-900 dark:text-white mb-2">{{ t("settings.exportTitle") }}</h2>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">{{ t("settings.exportNote") }}</p>
        <button
          type="button"
          @click="exportMailbox"
          :disabled="exporting"
          class="px-4 py-2 bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-900 rounded-lg font-medium hover:opacity-90 disabled:opacity-60"
        >
          {{ exporting ? t("settings.exporting") : t("settings.exportSubmit") }}
        </button>
      </div>

      <!-- Danger zone: deletion lock and mailbox deletion -->
      <div class="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
        <h2 class="text-lg font-medium text-red-700 dark:text-red-400 mb-4">{{ t("settings.dangerZoneTitle") }}</h2>

        <div class="flex items-center justify-between mb-4">
          <div class="pr-4">
            <h3 class="text-base font-medium text-gray-900 dark:text-white">{{ t("settings.deletionLockTitle") }}</h3>
            <p class="text-sm text-gray-500 dark:text-gray-400">{{ t("settings.deletionLockDescription") }}</p>
          </div>
          <label class="relative inline-flex items-center cursor-pointer flex-shrink-0">
            <input type="checkbox" :checked="deletionLocked" :disabled="lockLoading" @change="toggleDeletionLock" class="sr-only peer" />
            <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:after:border-gray-600 peer-checked:bg-indigo-600 peer-disabled:opacity-50"></div>
          </label>
        </div>

        <div class="rounded-md border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-900/10 p-4">
          <h3 class="text-base font-medium text-gray-900 dark:text-white">{{ t("settings.deleteMailboxTitle") }}</h3>
          <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">{{ t("settings.deleteMailboxDescription") }}</p>

          <p v-if="deletionLocked" class="text-sm text-gray-600 dark:text-gray-400 mt-3 flex items-center gap-1.5">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            {{ t("settings.deleteMailboxLockedHint") }}
          </p>

          <div v-else class="mt-3 space-y-3">
            <label class="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
              <input type="checkbox" v-model="purgeEmails" class="mt-1 rounded border-gray-300 text-red-600 focus:ring-red-500" />
              <span>{{ t("settings.deleteMailboxPurgeLabel") }}</span>
            </label>
            <div>
              <label class="block text-sm text-gray-700 dark:text-gray-300 mb-1">
                {{ t("settings.deleteMailboxConfirmLabel", { email: mailbox.email }) }}
              </label>
              <input
                type="text"
                v-model="deleteConfirmInput"
                autocomplete="off"
                :placeholder="mailbox.email"
                class="block w-full bg-white dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-md shadow-sm focus:ring-red-500 focus:border-red-500 sm:text-sm p-3"
              />
            </div>
            <button
              type="button"
              @click="deleteMailbox"
              :disabled="deleteConfirmInput.trim() !== mailbox.email || deleteLoading"
              class="px-4 py-2 bg-red-600 text-white rounded-md hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {{ deleteLoading ? t("settings.deleteMailboxDeleting") : t("settings.deleteMailboxButton") }}
            </button>
          </div>
          <p v-if="deleteError" class="text-sm text-red-600 dark:text-red-400 mt-2">{{ deleteError }}</p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import RichTextEditor from "@/components/RichTextEditor.vue";
import api from "@/services/api";
import {
	getExistingSubscription,
	isPushSupported,
	subscribeToPush,
	unsubscribeFromPush,
} from "@/services/push";
import { useMailboxStore } from "@/stores/mailboxes";
import { htmlToPlainText } from "@/utils/htmlToPlainText";

const { t } = useI18n();
const mailboxStore = useMailboxStore();
const { currentMailbox: mailbox } = storeToRefs(mailboxStore);
const route = useRoute();
const router = useRouter();

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

// Was `div.innerHTML = html` on a detached div. Even out of the document an
// <img src=x onerror=...> can fire, which made a signature able to run script
// in whoever opened these settings. DOMParser's document has no browsing
// context, so nothing in the markup runs or loads.
const exporting = ref(false);

/**
 * Fetched through the API client and handed over as a blob: the endpoint
 * needs the session, which a plain link would not carry. That does mean the
 * archive passes through browser memory, which is the practical ceiling on
 * how large a mailbox this can export in one go.
 */
async function exportMailbox() {
	if (exporting.value) return;
	exporting.value = true;
	try {
		const mailboxId = route.params.mailboxId as string;
		const response = await api.exportMailbox(mailboxId);
		const url = URL.createObjectURL(response.data as Blob);
		const link = document.createElement("a");
		link.href = url;
		const stamp = new Date().toISOString().slice(0, 10);
		link.download = `${mailboxId}-${stamp}.mbox`;
		document.body.appendChild(link);
		link.click();
		// Revoked on a later tick: releasing it in the same one can cut the
		// download off before the browser has taken the data.
		setTimeout(() => {
			link.remove();
			URL.revokeObjectURL(url);
		}, 1000);
	} catch {
		window.alert(t("settings.exportFailed"));
	} finally {
		exporting.value = false;
	}
}

const stripHtml = (html: string): string => htmlToPlainText(html);

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

// Deletion lock. An absent flag means locked -- the server decides the same
// way (isDeletionLocked), so a mailbox saved before this setting existed is
// protected rather than silently deletable.
const deletionLocked = ref(true);
const lockLoading = ref(false);
const purgeEmails = ref(false);
const deleteConfirmInput = ref("");
const deleteLoading = ref(false);
const deleteError = ref("");

watch(
	mailbox,
	(m) => {
		deletionLocked.value = m?.settings?.deletionLocked !== false;
	},
	{ immediate: true },
);

const toggleDeletionLock = async () => {
	if (!mailbox.value) return;
	const next = !deletionLocked.value;
	if (!next && !confirm(t("settings.deletionLockConfirmUnlock"))) return;

	lockLoading.value = true;
	deleteError.value = "";
	try {
		await mailboxStore.updateMailbox(route.params.mailboxId as string, {
			...mailbox.value.settings,
			deletionLocked: next,
		});
		deletionLocked.value = next;
	} finally {
		lockLoading.value = false;
	}
};

const deleteMailbox = async () => {
	if (!mailbox.value) return;
	if (deleteConfirmInput.value.trim() !== mailbox.value.email) return;
	if (
		!confirm(
			purgeEmails.value
				? t("settings.deleteMailboxConfirmPurge")
				: t("settings.deleteMailboxConfirm"),
		)
	) {
		return;
	}

	deleteLoading.value = true;
	deleteError.value = "";
	try {
		await mailboxStore.deleteMailbox(
			route.params.mailboxId as string,
			purgeEmails.value,
		);
		router.push({ name: "Home" });
	} catch (e: any) {
		deleteError.value =
			e.response?.data?.error || t("settings.deleteMailboxFailed");
	} finally {
		deleteLoading.value = false;
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

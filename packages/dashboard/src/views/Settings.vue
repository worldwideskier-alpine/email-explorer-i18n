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

      <!-- Automatic backup. There is no delete control here, and that is the
           design: rotation is the only thing that removes an archive. -->
      <div class="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
        <div class="flex items-center justify-between mb-2">
          <div class="pr-4">
            <h2 class="text-lg font-medium text-gray-900 dark:text-white">{{ t("settings.autoBackupTitle") }}</h2>
            <p class="text-sm text-gray-500 dark:text-gray-400">{{ t("settings.autoBackupDescription") }}</p>
          </div>
          <label class="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" v-model="autoBackupEnabled" :disabled="autoBackupSaving" class="sr-only peer" />
            <div class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:after:border-gray-600 peer-checked:bg-indigo-600 peer-disabled:opacity-50"></div>
          </label>
        </div>

        <div v-if="autoBackupEnabled" class="mt-4 space-y-4">
          <div class="flex flex-wrap gap-4">
            <div>
              <label for="backupFrequency" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("settings.autoBackupFrequency") }}</label>
              <select
                id="backupFrequency"
                v-model="autoBackupFrequency"
                class="mt-1 bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm p-2"
              >
                <option value="daily">{{ t("settings.autoBackupDaily") }}</option>
                <option value="weekly">{{ t("settings.autoBackupWeekly") }}</option>
                <option value="monthly">{{ t("settings.autoBackupMonthly") }}</option>
              </select>
            </div>
            <div>
              <label for="backupKeep" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("settings.autoBackupKeep") }}</label>
              <input
                id="backupKeep"
                type="number"
                v-model.number="autoBackupKeep"
                :min="autoBackupKeepFloor"
                max="365"
                class="mt-1 w-28 bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm p-2"
              />
            </div>
          </div>

          <p class="text-sm text-amber-700 dark:text-amber-400">{{ t("settings.autoBackupKeepNote", { keep: autoBackupKeepFloor }) }}</p>
          <p class="text-sm text-gray-600 dark:text-gray-400">{{ t("settings.autoBackupWindowNote") }}</p>

          <button
            type="button"
            @click="saveAutoBackup"
            :disabled="autoBackupSaving"
            class="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {{ t("settings.save") }}
          </button>
          <p v-if="autoBackupMessage" class="text-sm text-green-600 dark:text-green-400">{{ autoBackupMessage }}</p>

          <p class="text-sm" :class="autoBackupLastOk === false ? 'text-red-600 dark:text-red-400' : 'text-gray-600 dark:text-gray-400'">
            {{ autoBackupLastLine }}
          </p>

          <div v-if="backups.length">
            <h3 class="text-base font-medium text-gray-900 dark:text-white mb-2">{{ t("settings.autoBackupStored") }}</h3>
            <ul class="divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-lg">
              <li v-for="backup in backups" :key="backup.name" class="flex items-center justify-between gap-4 px-4 py-2">
                <span class="text-sm text-gray-700 dark:text-gray-300 break-all">{{ backup.name }}</span>
                <span class="text-sm text-gray-500 dark:text-gray-400 whitespace-nowrap">{{ formatSize(backup.size) }}</span>
                <button
                  type="button"
                  @click="downloadBackup(backup.name)"
                  class="text-sm text-indigo-600 dark:text-indigo-400 hover:underline whitespace-nowrap"
                >
                  {{ t("settings.autoBackupDownload") }}
                </button>
              </li>
            </ul>
          </div>
          <p v-else class="text-sm text-gray-500 dark:text-gray-400">{{ t("settings.autoBackupNone") }}</p>
        </div>
      </div>

      <!-- Restore: the other half of the backup. Admin only, because the
           endpoint it posts to writes mail into the mailbox. -->
      <div v-if="isAdmin" class="border-t border-gray-200 dark:border-gray-700 mt-6 pt-6">
        <h2 class="text-lg font-medium text-gray-900 dark:text-white mb-2">{{ t("settings.restoreTitle") }}</h2>
        <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">{{ t("settings.restoreNote") }}</p>
        <div class="flex flex-wrap items-center gap-3">
          <input
            ref="restoreInput"
            type="file"
            accept=".mbox,message/rfc822,application/mbox,text/plain"
            :disabled="restoring"
            @change="onRestoreFileChosen"
            class="text-sm text-gray-700 dark:text-gray-300 file:mr-3 file:px-4 file:py-2 file:rounded-lg file:border-0 file:bg-gray-800 dark:file:bg-gray-200 file:text-white dark:file:text-gray-900 file:font-medium file:cursor-pointer disabled:opacity-60"
          />
          <button
            type="button"
            @click="restoreMailbox"
            :disabled="restoring || !restoreFile"
            class="px-4 py-2 bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-900 rounded-lg font-medium hover:opacity-90 disabled:opacity-60"
          >
            {{ restoring ? t("settings.restoreRunning") : t("settings.restoreSubmit") }}
          </button>
        </div>
        <p v-if="restoring" class="text-sm text-gray-600 dark:text-gray-400 mt-3">
          {{ t("settings.restoreProgress", { done: restoreDone, total: restoreTotal }) }}
        </p>
        <p v-if="restoreSummary" class="text-sm text-green-600 dark:text-green-400 mt-3">{{ restoreSummary }}</p>
        <p v-if="restoreError" class="text-sm text-red-600 dark:text-red-400 mt-3">{{ restoreError }}</p>
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
import { useAuthStore } from "@/stores/auth";
import { useMailboxStore } from "@/stores/mailboxes";
import { htmlToPlainText } from "@/utils/htmlToPlainText";
import { parseMbox, toBase64 } from "@/utils/mbox";

const { t } = useI18n();
const mailboxStore = useMailboxStore();
const { currentMailbox: mailbox } = storeToRefs(mailboxStore);
const { isAdmin } = storeToRefs(useAuthStore());
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
	loadBackups();
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

const autoBackupEnabled = ref(false);
const autoBackupFrequency = ref<"daily" | "weekly" | "monthly">("daily");
const autoBackupKeep = ref(7);
/**
 * The retention count may rise and never fall, because rotation is the only
 * thing that deletes an archive and lowering the count would delete on the
 * next run. The server enforces it; this is only so the field says so rather
 * than silently discarding what was typed.
 */
const autoBackupKeepFloor = ref(1);
const autoBackupSaving = ref(false);
const autoBackupMessage = ref("");
const autoBackupLastOk = ref<boolean | undefined>(undefined);
const autoBackupLastLine = ref("");
const backups = ref<{ name: string; at: string; size: number }[]>([]);

watch(
	mailbox,
	(m) => {
		const backup = m?.settings?.autoBackup;
		autoBackupEnabled.value = !!backup?.enabled;
		autoBackupFrequency.value = backup?.frequency ?? "daily";
		autoBackupKeep.value = backup?.keep ?? 7;
		autoBackupKeepFloor.value = backup?.keep ?? 1;

		const last = backup?.lastResult;
		autoBackupLastOk.value = last?.ok;
		autoBackupLastLine.value = !last
			? t("settings.autoBackupNeverRun")
			: last.ok
				? t("settings.autoBackupLastOk", {
						at: new Date(last.at).toLocaleString(),
						messages: last.messages ?? 0,
					})
				: t("settings.autoBackupLastFailed", {
						at: new Date(last.at).toLocaleString(),
						error: last.error ?? "",
					});
	},
	{ immediate: true },
);

const formatSize = (bytes: number): string => {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

async function loadBackups() {
	try {
		const response = await api.listBackups(route.params.mailboxId as string);
		backups.value = response.data ?? [];
	} catch {
		backups.value = [];
	}
}

async function saveAutoBackup() {
	if (autoBackupSaving.value) return;
	autoBackupSaving.value = true;
	autoBackupMessage.value = "";
	try {
		const mailboxId = route.params.mailboxId as string;
		await api.updateMailbox(mailboxId, {
			...(mailbox.value?.settings ?? {}),
			autoBackup: {
				enabled: autoBackupEnabled.value,
				frequency: autoBackupFrequency.value,
				keep: autoBackupKeep.value,
			},
		});
		await mailboxStore.fetchMailbox(mailboxId);
		await loadBackups();
		autoBackupMessage.value = t("settings.autoBackupSaved");
	} catch {
		autoBackupMessage.value = "";
	} finally {
		autoBackupSaving.value = false;
	}
}

async function downloadBackup(name: string) {
	try {
		const mailboxId = route.params.mailboxId as string;
		const response = await api.downloadBackup(mailboxId, name);
		const url = URL.createObjectURL(response.data as Blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `${mailboxId}-${name}`;
		document.body.appendChild(link);
		link.click();
		setTimeout(() => {
			link.remove();
			URL.revokeObjectURL(url);
		}, 1000);
	} catch {
		window.alert(t("settings.exportFailed"));
	}
}

const restoreInput = ref<HTMLInputElement | null>(null);
const restoreFile = ref<File | null>(null);
const restoring = ref(false);
const restoreDone = ref(0);
const restoreTotal = ref(0);
const restoreSummary = ref("");
const restoreError = ref("");

function onRestoreFileChosen(event: Event) {
	restoreFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
	restoreSummary.value = "";
	restoreError.value = "";
}

/**
 * Reads the archive here and posts one message at a time, rather than handing
 * the file to the Worker: an mbox is as large as the mailbox it came from,
 * which is more than a single request can carry, and a message at a time is
 * what lets this report progress and survive a failure partway.
 *
 * Running it twice is safe. Each message carries the id its backup recorded,
 * and the Worker answers "duplicate" without writing for one it already has,
 * so a restore interrupted halfway can simply be run again.
 */
async function restoreMailbox() {
	const file = restoreFile.value;
	if (!file || restoring.value) return;

	restoring.value = true;
	restoreSummary.value = "";
	restoreError.value = "";
	restoreDone.value = 0;
	restoreTotal.value = 0;

	try {
		const mailboxId = route.params.mailboxId as string;
		const entries = parseMbox(await file.text());
		restoreTotal.value = entries.length;

		let imported = 0;
		let skipped = 0;
		let failed = 0;

		for (const entry of entries) {
			try {
				const response = await api.importEmail(mailboxId, {
					rawEmailBase64: toBase64(entry.raw),
					folder: entry.folder,
					id: entry.id,
					date: entry.date,
					read: entry.read,
					starred: entry.starred,
				});
				if (response.data?.status === "duplicate") skipped += 1;
				else imported += 1;
			} catch {
				// One unreadable message must not end the restore: the rest of
				// the archive is still worth putting back, and the count says
				// how many did not make it.
				failed += 1;
			}
			restoreDone.value += 1;
		}

		restoreSummary.value = t("settings.restoreDone", {
			imported,
			skipped,
			failed,
		});
		await mailboxStore.fetchMailbox(mailboxId);
	} catch {
		restoreError.value = t("settings.restoreFailed");
	} finally {
		restoring.value = false;
		restoreFile.value = null;
		if (restoreInput.value) restoreInput.value.value = "";
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

<template>
  <div class="bg-white dark:bg-gray-800 shadow-md rounded-lg">
    <div class="p-4 border-b border-gray-200 dark:border-gray-700">
      <h1 class="text-xl font-semibold text-gray-900 dark:text-white">{{ t("searchResults.title") }}</h1>
    </div>
    <div v-if="isLoading" class="p-4 text-center text-gray-500 dark:text-gray-400">
      <p>{{ t("searchResults.loading") }}</p>
    </div>
    <!-- A search that could not be made is not one that found nothing. -->
    <div v-else-if="failedHere" class="p-4 text-center" role="alert">
      <p class="text-gray-700 dark:text-gray-300 mb-4">{{ t("common.loadFailed") }}</p>
      <button
        type="button"
        @click="searchAgain"
        class="px-4 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 rounded-lg hover:bg-indigo-100 dark:text-indigo-300 dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
      >
        {{ t("common.retry") }}
      </button>
    </div>
    <div v-else-if="shown.length === 0" class="p-4 text-center text-gray-500 dark:text-gray-400">
      <p>{{ t("searchResults.noResults") }}</p>
    </div>
    <ul v-else class="divide-y divide-gray-200 dark:divide-gray-700">
      <li v-for="email in shown" :key="email.id">
        <router-link :to="{ name: 'EmailDetail', params: { id: email.id }, query: email.folder_id ? { fromFolder: email.folder_id } : {} }" class="block p-4 hover:bg-gray-50 dark:hover:bg-gray-700">
          <div class="flex items-center justify-between">
            <p class="text-sm font-medium text-gray-900 dark:text-white truncate">{{ email.sender }}</p>
            <p class="text-xs text-gray-500 dark:text-gray-400">{{ formatListDate(email.date) }}</p>
          </div>
          <div class="flex items-center gap-1.5 mt-1">
            <SentOnMarks :replied-at="email.replied_at" :forwarded-at="email.forwarded_at" />
            <p class="text-sm text-gray-800 dark:text-gray-300">{{ email.subject }}</p>
          </div>
        </router-link>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import SentOnMarks from "@/components/SentOnMarks.vue";
import { useDateFormat } from "@/composables/useDateFormat";
import { useSearchStore } from "@/stores/search";

const { t } = useI18n();
const { formatListDate } = useDateFormat();
const searchStore = useSearchStore();
const { results, isLoading, failed } = storeToRefs(searchStore);
const route = useRoute();
const router = useRouter();

const mailboxId = computed(() => route.params.mailboxId as string);
/**
 * What is searched for is the address's, not only the store's. Held in the
 * store alone, a reload, a shared link or coming back to this screen showed
 * "No results found" for a search nobody had made.
 */
const asked = computed(() =>
	typeof route.query.q === "string" ? route.query.q : undefined,
);

// Only for the mailbox and the words in the address. The store holds one
// search, and it used to show under whichever mailbox was open next --
// links to messages that mailbox does not have.
const isThisSearch = computed(
	() =>
		searchStore.mailboxId === mailboxId.value &&
		searchStore.query === asked.value,
);
const shown = computed(() => (isThisSearch.value ? results.value : []));
const failedHere = computed(() => failed.value && isThisSearch.value);

watch(
	[mailboxId, asked],
	([mailbox, q]) => {
		if (!mailbox) return;
		// Nothing asked, so there is no answer to show; the mailbox is.
		if (q === undefined) {
			router.replace({
				name: "EmailList",
				params: { mailboxId: mailbox, folder: "inbox" },
			});
			return;
		}
		// The header has already asked this one on its way here.
		if (!isThisSearch.value) void searchStore.searchEmails(mailbox, q);
	},
	{ immediate: true },
);

const searchAgain = () =>
	searchStore.searchEmails(mailboxId.value, asked.value ?? "");
</script>

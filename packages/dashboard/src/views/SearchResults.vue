<template>
  <div class="bg-white dark:bg-gray-800 shadow-md rounded-lg">
    <div class="p-4 border-b border-gray-200 dark:border-gray-700">
      <h1 class="text-xl font-semibold text-gray-900 dark:text-white">{{ t("searchResults.title") }}</h1>
    </div>
    <div v-if="isLoading" class="p-4 text-center text-gray-500 dark:text-gray-400">
      <p>{{ t("searchResults.loading") }}</p>
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
          <p class="text-sm text-gray-800 dark:text-gray-300 mt-1">{{ email.subject }}</p>
        </router-link>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useDateFormat } from "@/composables/useDateFormat";
import { useSearchStore } from "@/stores/search";

const { t } = useI18n();
const { formatListDate } = useDateFormat();
const searchStore = useSearchStore();
const { results, isLoading } = storeToRefs(searchStore);
const route = useRoute();

// Only under the mailbox they came from. The store holds one mailbox's
// results, and they used to show under whichever mailbox was open next --
// links to messages that mailbox does not have.
const shown = computed(() =>
	searchStore.mailboxId === route.params.mailboxId ? results.value : [],
);
</script>

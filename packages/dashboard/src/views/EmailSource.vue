<template>
  <div class="bg-white dark:bg-gray-800 shadow-xl rounded-2xl overflow-hidden flex flex-col h-full border border-gray-200 dark:border-gray-700">
    <div class="p-4 sm:p-6 border-b border-gray-200 dark:border-gray-700 flex-shrink-0 bg-gradient-to-br from-white to-gray-50 dark:from-gray-800 dark:to-gray-900/50 flex items-center gap-3">
      <button @click="router.back()" class="p-2.5 text-gray-500 hover:text-indigo-600 dark:text-gray-400 dark:hover:text-indigo-400 rounded-xl hover:bg-indigo-50 dark:hover:bg-gray-700/50 transition-all duration-200 cursor-pointer flex-shrink-0" :title="t('emailDetail.back')">
        <svg xmlns="http://www.w3.org/2000/svg" class="h-5 w-5 rtl:-scale-x-100" viewBox="0 0 20 20" fill="currentColor">
          <path fill-rule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clip-rule="evenodd" />
        </svg>
      </button>
      <h1 class="text-lg sm:text-xl font-bold text-gray-900 dark:text-white truncate">{{ t("emailDetail.viewSource") }}</h1>
    </div>
    <div class="flex-grow overflow-auto p-4 sm:p-6">
      <p v-if="loading" class="text-gray-500 dark:text-gray-400">{{ t("emailDetail.viewSourceLoading") }}</p>
      <p v-else-if="error" class="text-red-600 dark:text-red-400">{{ error }}</p>
      <pre v-else class="whitespace-pre-wrap break-words text-xs sm:text-sm font-mono text-gray-800 dark:text-gray-200">{{ source }}</pre>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import api from "@/services/api";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

const source = ref("");
const loading = ref(true);
const error = useLocalizedMessage();

onMounted(async () => {
	const mailboxId = route.params.mailboxId as string;
	const emailId = route.params.id as string;
	try {
		const response = await api.getEmailSource(mailboxId, emailId);
		source.value = response.data;
	} catch (_err) {
		error.value = () => t("emailDetail.viewSourceFailed");
	} finally {
		loading.value = false;
	}
});
</script>

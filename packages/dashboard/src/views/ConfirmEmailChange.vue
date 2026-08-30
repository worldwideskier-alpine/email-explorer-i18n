<template>
  <div class="min-h-screen flex items-center justify-center px-4">
    <div class="max-w-md w-full text-center">
      <h1 class="text-2xl font-bold text-gray-900 dark:text-white mb-4">
        {{ t("confirmEmailChange.title") }}
      </h1>

      <p v-if="state === 'working'" class="text-gray-600 dark:text-gray-400">
        {{ t("confirmEmailChange.working") }}
      </p>

      <div v-else-if="state === 'done'" class="space-y-4">
        <p class="text-green-700 dark:text-green-400">{{ t("confirmEmailChange.done") }}</p>
        <p class="text-sm text-gray-600 dark:text-gray-400">{{ t("confirmEmailChange.doneNote") }}</p>
        <router-link to="/login" class="inline-block px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700">
          {{ t("confirmEmailChange.toLogin") }}
        </router-link>
      </div>

      <div v-else class="space-y-4">
        <p class="text-red-700 dark:text-red-400">{{ errorMessage }}</p>
        <router-link to="/login" class="inline-block px-6 py-3 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-lg font-semibold">
          {{ t("confirmEmailChange.toLogin") }}
        </router-link>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import api from "@/services/api";
import { translateApiError } from "@/utils/apiError";

const { t } = useI18n();
const route = useRoute();

const state = ref<"working" | "done" | "failed">("working");
const errorMessage = useLocalizedMessage();

onMounted(async () => {
	const token = route.query.token as string | undefined;
	if (!token) {
		state.value = "failed";
		errorMessage.value = () => t("confirmEmailChange.missingToken");
		return;
	}
	try {
		await api.confirmEmailChange(token);
		state.value = "done";
	} catch (e: any) {
		state.value = "failed";
		errorMessage.value = () =>
			translateApiError(
				e.response?.data?.error,
				t("confirmEmailChange.failed"),
			);
	}
});
</script>

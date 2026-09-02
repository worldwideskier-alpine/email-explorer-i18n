<template>
  <div class="container mx-auto p-4 sm:p-6 lg:p-8 max-w-3xl">
    <div class="mb-8 flex items-center justify-between gap-4">
      <div>
        <h1 class="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">{{ t("account.title") }}</h1>
        <p class="text-gray-600 dark:text-gray-400 mt-1">{{ t("account.subtitle") }}</p>
      </div>
      <div class="flex items-center gap-2 flex-shrink-0">
        <router-link
          to="/"
          class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700 transition-colors"
        >
          {{ t("account.backToHome") }}
        </router-link>
        <LanguageSwitcher />
      </div>
    </div>

    <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 mb-6">
      <h2 class="text-lg font-bold text-gray-900 dark:text-white mb-2">{{ t("account.signInAddress") }}</h2>
      <p class="text-gray-900 dark:text-gray-100 break-all">{{ authStore.currentUser?.email }}</p>
      <!-- The role, not the legacy is_admin column. That column is set for
           the first account ever registered and for no other, so this said
           "administrator" to one person and nothing at all to every other
           administrator -- on a screen whose whole subject is who you are. -->
      <p v-if="authStore.role === 'admin'" class="text-xs text-indigo-600 dark:text-indigo-400 font-semibold mt-1">
        {{ t("account.isAdmin") }}
      </p>
    </div>

    <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6 mb-6">
      <h2 class="text-lg font-bold text-gray-900 dark:text-white mb-1">{{ t("account.changePassword.title") }}</h2>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">{{ t("account.changePassword.note") }}</p>
      <form @submit.prevent="submitPassword" class="space-y-4">
        <input
          type="password"
          v-model="currentPasswordForPassword"
          autocomplete="current-password"
          required
          :placeholder="t('account.currentPassword')"
          class="block w-full bg-gray-50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-900 dark:text-gray-100"
        />
        <input
          type="password"
          v-model="newPassword"
          autocomplete="new-password"
          required
          minlength="8"
          :placeholder="t('account.changePassword.newPassword')"
          class="block w-full bg-gray-50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-900 dark:text-gray-100"
        />
        <input
          type="password"
          v-model="newPasswordConfirm"
          autocomplete="new-password"
          required
          :placeholder="t('account.changePassword.confirmPassword')"
          class="block w-full bg-gray-50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-900 dark:text-gray-100"
        />
        <button
          type="submit"
          :disabled="passwordLoading"
          class="px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-70"
        >
          {{ passwordLoading ? t("account.saving") : t("account.changePassword.submit") }}
        </button>
      </form>
    </div>

    <div class="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-6">
      <h2 class="text-lg font-bold text-gray-900 dark:text-white mb-1">{{ t("account.changeEmail.title") }}</h2>
      <p class="text-sm text-gray-600 dark:text-gray-400 mb-4">{{ t("account.changeEmail.note") }}</p>
      <form @submit.prevent="submitEmail" class="space-y-4">
        <input
          type="password"
          v-model="currentPasswordForEmail"
          autocomplete="current-password"
          required
          :placeholder="t('account.currentPassword')"
          class="block w-full bg-gray-50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-900 dark:text-gray-100"
        />
        <input
          type="email"
          v-model="newEmail"
          required
          :placeholder="t('account.changeEmail.newEmail')"
          class="block w-full bg-gray-50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-lg px-4 py-3 text-gray-900 dark:text-gray-100"
        />
        <button
          type="submit"
          :disabled="emailLoading"
          class="px-6 py-3 bg-indigo-600 text-white rounded-lg font-semibold hover:bg-indigo-700 disabled:opacity-70"
        >
          {{ emailLoading ? t("account.saving") : t("account.changeEmail.submit") }}
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import LanguageSwitcher from "@/components/LanguageSwitcher.vue";
import { useToast } from "@/composables/useToast";
import api from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { translateApiError } from "@/utils/apiError";

const { t, locale } = useI18n();
const { success, error: showError } = useToast();
const authStore = useAuthStore();

const currentPasswordForPassword = ref("");
const newPassword = ref("");
const newPasswordConfirm = ref("");
const passwordLoading = ref(false);

const currentPasswordForEmail = ref("");
const newEmail = ref("");
const emailLoading = ref(false);

async function submitPassword() {
	if (newPassword.value !== newPasswordConfirm.value) {
		showError(t("account.changePassword.mismatch"));
		return;
	}
	passwordLoading.value = true;
	try {
		await api.changePassword(
			currentPasswordForPassword.value,
			newPassword.value,
		);
		currentPasswordForPassword.value = "";
		newPassword.value = "";
		newPasswordConfirm.value = "";
		success(t("account.changePassword.done"));
	} catch (e: any) {
		showError(
			translateApiError(
				e.response?.data?.error,
				t("account.changePassword.failed"),
			),
		);
	} finally {
		passwordLoading.value = false;
	}
}

async function submitEmail() {
	emailLoading.value = true;
	try {
		await api.changeEmail(
			currentPasswordForEmail.value,
			newEmail.value,
			locale.value,
		);
		success(t("account.changeEmail.sent", { email: newEmail.value }));
		currentPasswordForEmail.value = "";
		newEmail.value = "";
	} catch (e: any) {
		showError(
			translateApiError(
				e.response?.data?.error,
				t("account.changeEmail.failed"),
			),
		);
	} finally {
		emailLoading.value = false;
	}
}
</script>

<template>
	<div v-if="!isRegistrationEnabled()" class="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
		<div class="max-w-md w-full text-center">
			<h2 class="text-2xl font-bold text-gray-900 dark:text-white mb-4">{{ t("register.disabledTitle") }}</h2>
			<p class="text-gray-600 dark:text-gray-400 mb-6">{{ t("register.disabledMessage") }}</p>
			<router-link to="/login" class="text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300 font-medium">
				{{ t("register.returnToLogin") }}
			</router-link>
		</div>
	</div>
	<div v-else class="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
		<div class="max-w-md w-full space-y-8">
			<div>
				<h2 class="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-white">
					{{ t("register.title") }}
				</h2>
				<p class="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
					{{ t("register.signInPrompt") }}
					<router-link
						to="/login"
						class="font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300"
					>
						{{ t("register.signInLink") }}
					</router-link>
				</p>
			</div>
			<form class="mt-8 space-y-6" @submit.prevent="handleRegister">
				<div v-if="authStore.error" class="rounded-md bg-red-50 p-4">
					<p class="text-sm text-red-800">{{ authStore.error }}</p>
				</div>
				<div v-if="successMessage" class="rounded-md bg-green-50 p-4">
					<p class="text-sm text-green-800">{{ successMessage }}</p>
				</div>
				<div class="rounded-md shadow-sm -space-y-px">
					<div>
						<label for="email" class="sr-only">{{ t("common.emailAddress") }}</label>
						<input
							id="email"
							v-model="email"
							type="email"
							required
							class="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
							:placeholder="t('register.emailPlaceholder')"
						/>
					</div>
					<div>
						<label for="password" class="sr-only">{{ t("common.password") }}</label>
						<input
							id="password"
							v-model="password"
							type="password"
							required
							minlength="8"
							class="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
							:placeholder="t('register.passwordPlaceholder')"
						/>
					</div>
					<div>
						<label for="confirm-password" class="sr-only">{{ t("common.confirmPassword") }}</label>
						<input
							id="confirm-password"
							v-model="confirmPassword"
							type="password"
							required
							class="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-b-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
							:placeholder="t('register.confirmPasswordPlaceholder')"
						/>
					</div>
				</div>

				<div>
					<button
						type="submit"
						:disabled="authStore.loading || password !== confirmPassword"
						class="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
					>
						{{ authStore.loading ? t("register.creatingAccount") : t("register.createAccount") }}
					</button>
					<p v-if="password && confirmPassword && password !== confirmPassword" class="mt-2 text-sm text-red-600">
						{{ t("common.passwordsDoNotMatch") }}
					</p>
				</div>
			</form>
		</div>
	</div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useAppSettings } from "@/composables/useAppSettings";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const authStore = useAuthStore();
const { t } = useI18n();
const { isRegistrationEnabled } = useAppSettings();

const email = ref("");
const password = ref("");
const confirmPassword = ref("");
const successMessage = useLocalizedMessage();

async function handleRegister() {
	if (password.value !== confirmPassword.value) {
		return;
	}

	try {
		await authStore.register(email.value, password.value);
		successMessage.value = () => t("register.accountCreated");
		setTimeout(() => {
			router.push("/");
		}, 1000);
	} catch (error) {
		// Error is handled by store
	}
}
</script>

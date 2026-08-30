<template>
	<div class="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
		<div class="max-w-md w-full space-y-8">
			<div>
				<h2 class="mt-6 text-center text-3xl font-extrabold text-gray-900 dark:text-white">
					{{ t("login.title") }}
				</h2>
				<p class="mt-2 text-center text-sm text-gray-600 dark:text-gray-400">
					<span v-if="isRegistrationEnabled()">
						{{ t("login.createAccountPrompt") }}
						<router-link
							to="/register"
							class="font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300"
						>
							{{ t("login.createAccountLink") }}
						</router-link>
					</span>
				</p>
			</div>
			<form class="mt-8 space-y-6" @submit.prevent="handleLogin">
				<div v-if="authStore.error" class="rounded-md bg-red-50 p-4">
					<p class="text-sm text-red-800">{{ authStore.error }}</p>
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
							:placeholder="t('login.emailPlaceholder')"
						/>
					</div>
					<div>
						<label for="password" class="sr-only">{{ t("common.password") }}</label>
						<input
							id="password"
							v-model="password"
							type="password"
							required
							class="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-b-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
							:placeholder="t('login.passwordPlaceholder')"
						/>
					</div>
				</div>

				<div>
					<button
						type="submit"
						:disabled="authStore.loading"
						class="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
					>
						{{ authStore.loading ? t("login.signingIn") : t("login.signIn") }}
					</button>
				</div>
			<div v-if="isAccountRecoveryEnabled()" class="text-center">
				<router-link
					to="/forgot-password"
					class="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:text-indigo-500 dark:hover:text-indigo-300"
				>
					{{ t("login.forgotPassword") }}
				</router-link>
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
import { useAuthStore } from "@/stores/auth";

const router = useRouter();
const authStore = useAuthStore();
const { t } = useI18n();
const { isRegistrationEnabled, isAccountRecoveryEnabled } = useAppSettings();

const email = ref("");
const password = ref("");

async function handleLogin() {
	try {
		await authStore.login(email.value, password.value);
		router.push("/");
	} catch (error) {
		// Error is handled by store
	}
}
</script>

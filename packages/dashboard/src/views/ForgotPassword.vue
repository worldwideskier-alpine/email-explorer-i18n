<template>
	<div class="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
		<div class="max-w-md w-full space-y-8">
			<div>
				<h2 class="mt-6 text-center text-3xl font-extrabold text-gray-900">
					{{ t("forgotPassword.title") }}
				</h2>
				<p class="mt-2 text-center text-sm text-gray-600">
					{{ t("forgotPassword.returnToLoginPrompt") }}
					<router-link
						to="/login"
						class="font-medium text-indigo-600 hover:text-indigo-500"
					>
						{{ t("forgotPassword.returnToLoginLink") }}
					</router-link>
				</p>
			</div>

			<form class="mt-8 space-y-6" @submit.prevent="handleForgotPassword">
				<div v-if="error" class="rounded-md bg-red-50 p-4">
					<p class="text-sm text-red-800">{{ error }}</p>
				</div>

				<div v-if="successMessage" class="rounded-md bg-green-50 p-4">
					<p class="text-sm text-green-800">{{ successMessage }}</p>
				</div>

				<div v-if="!successMessage" class="rounded-md shadow-sm">
					<div>
						<label for="email" class="sr-only">{{ t("common.emailAddress") }}</label>
						<input
							id="email"
							v-model="email"
							type="email"
							required
							class="appearance-none rounded-md relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
							:placeholder="t('forgotPassword.emailPlaceholder')"
						/>
					</div>
				</div>

				<div v-if="!successMessage">
					<button
						type="submit"
						:disabled="isLoading"
						class="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
					>
						{{ isLoading ? t("forgotPassword.sending") : t("forgotPassword.sendResetLink") }}
					</button>
				</div>

				<div v-if="successMessage" class="text-center">
					<router-link
						to="/login"
						class="text-sm font-medium text-indigo-600 hover:text-indigo-500"
					>
						{{ t("forgotPassword.backToLogin") }}
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
import { useToast } from "@/composables/useToast";
import api from "@/services/api";

const router = useRouter();
const { t, locale } = useI18n();
const { success, error: showError } = useToast();

const email = ref("");
const isLoading = ref(false);
const error = ref<string | null>(null);
const successMessage = ref<string | null>(null);

async function handleForgotPassword() {
	error.value = null;
	isLoading.value = true;

	try {
		await api.forgotPassword(email.value, locale.value);
		successMessage.value = t("forgotPassword.linkSent", { email: email.value });
		success(t("forgotPassword.linkSentToast"));
	} catch (e: any) {
		const errorMessage =
			e.response?.data?.error || t("forgotPassword.failedToSend");
		error.value = errorMessage;
		showError(errorMessage);
	} finally {
		isLoading.value = false;
	}
}
</script>

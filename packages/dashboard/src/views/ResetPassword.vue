<template>
	<div class="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
		<div class="max-w-md w-full space-y-8">
			<div>
				<h2 class="mt-6 text-center text-3xl font-extrabold text-gray-900">
					{{ t("resetPassword.title") }}
				</h2>
				<p class="mt-2 text-center text-sm text-gray-600">
					{{ t("resetPassword.subtitle") }}
				</p>
			</div>

			<form class="mt-8 space-y-6" @submit.prevent="handleResetPassword">
				<div v-if="error" class="rounded-md bg-red-50 p-4">
					<p class="text-sm text-red-800">{{ error }}</p>
				</div>

				<div v-if="successMessage" class="rounded-md bg-green-50 p-4">
					<p class="text-sm text-green-800">{{ successMessage }}</p>
				</div>

				<div v-if="!successMessage" class="rounded-md shadow-sm -space-y-px">
					<div>
						<label for="password" class="sr-only">{{ t("common.password") }}</label>
						<input
							id="password"
							v-model="password"
							type="password"
							required
							minlength="8"
							class="appearance-none rounded-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-t-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
							:placeholder="t('resetPassword.passwordPlaceholder')"
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
							:placeholder="t('resetPassword.confirmPasswordPlaceholder')"
						/>
					</div>
				</div>

				<div v-if="password && confirmPassword && password !== confirmPassword" class="text-sm text-red-600">
					{{ t("common.passwordsDoNotMatch") }}
				</div>

				<div v-if="!successMessage">
					<button
						type="submit"
						:disabled="isLoading || password !== confirmPassword || !password"
						class="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
					>
						{{ isLoading ? t("resetPassword.resetting") : t("resetPassword.resetPassword") }}
					</button>
				</div>

				<div v-if="successMessage" class="text-center">
					<router-link
						to="/login"
						class="text-sm font-medium text-indigo-600 hover:text-indigo-500"
					>
						{{ t("resetPassword.backToLogin") }}
					</router-link>
				</div>
			</form>
		</div>
	</div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { useToast } from "@/composables/useToast";
import api from "@/services/api";

const router = useRouter();
const route = useRoute();
const { t } = useI18n();
const { success, error: showError } = useToast();

const password = ref("");
const confirmPassword = ref("");
const isLoading = ref(false);
const error = ref<string | null>(null);
const successMessage = ref<string | null>(null);

const token = ref<string | null>(null);

onMounted(() => {
	token.value = route.query.token as string;
	if (!token.value) {
		error.value = t("resetPassword.invalidLink");
	}
});

async function handleResetPassword() {
	if (!token.value) {
		error.value = t("resetPassword.invalidLink");
		return;
	}

	if (password.value !== confirmPassword.value) {
		error.value = t("common.passwordsDoNotMatch");
		return;
	}

	error.value = null;
	isLoading.value = true;

	try {
		await api.resetPassword(token.value, password.value);
		successMessage.value = t("resetPassword.success");
		success(t("resetPassword.success"), 5000);
		setTimeout(() => {
			router.push("/login");
		}, 5000);
	} catch (e: any) {
		const errorMessage =
			e.response?.data?.error || t("resetPassword.failedToReset");
		error.value = errorMessage;
		showError(errorMessage);
	} finally {
		isLoading.value = false;
	}
}
</script>

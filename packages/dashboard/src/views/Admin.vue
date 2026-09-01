<template>
	<div class="container mx-auto p-4 sm:p-6 lg:p-8 max-w-7xl">
		<!-- Header -->
		<div class="mb-8 flex items-center justify-between">
			<div>
				<h1 class="text-3xl sm:text-4xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent mb-2">
					{{ t("admin.title") }}
				</h1>
				<p class="text-gray-600 dark:text-gray-400">{{ t("admin.subtitle") }}</p>
			</div>
			<div class="flex items-center gap-2 flex-shrink-0">
				<router-link
					to="/"
					class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700 transition-colors"
				>
					{{ t("admin.backToHome") }}
				</router-link>
				<LanguageSwitcher />
			</div>
		</div>

		<!-- Outbound mail. Your own key: the one your messages are sent with,
		     and the account they are billed to. The key itself is never sent
		     back here; the API answers only with whether one is set. -->
		<div class="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 mb-8 border border-gray-200 dark:border-gray-700">
			<h2 class="text-xl font-bold text-gray-900 dark:text-white mb-1">{{ t("admin.resend.title") }}</h2>
			<p class="text-sm text-gray-600 dark:text-gray-400 mb-4">{{ t("admin.resend.description") }}</p>

			<div class="flex items-center gap-2 mb-3">
				<span class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("admin.resend.statusLabel") }}:</span>
				<span
					v-if="resendSource === 'stored'"
					class="px-2 py-0.5 text-xs font-semibold text-green-800 bg-green-100 dark:bg-green-900/40 dark:text-green-300 rounded-full"
				>{{ t("admin.resend.sourceStored") }}</span>
				<span
					v-else-if="resendSource === 'environment'"
					class="px-2 py-0.5 text-xs font-semibold text-amber-800 bg-amber-100 dark:bg-amber-900/40 dark:text-amber-300 rounded-full"
				>{{ t("admin.resend.sourceEnvironment") }}</span>
				<span
					v-else
					class="px-2 py-0.5 text-xs font-semibold text-red-800 bg-red-100 dark:bg-red-900/40 dark:text-red-300 rounded-full"
				>{{ t("admin.resend.sourceNone") }}</span>
			</div>

			<form @submit.prevent="saveResendKey" class="flex flex-col sm:flex-row gap-2">
				<input
					id="resendApiKey"
					type="password"
					v-model="resendApiKeyInput"
					autocomplete="off"
					:placeholder="t('admin.resend.placeholder')"
					class="flex-grow bg-gray-50 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 rounded-lg shadow-sm sm:text-sm p-3"
				/>
				<button
					type="submit"
					:disabled="!resendApiKeyInput.trim() || resendSaving"
					class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 flex-shrink-0"
				>
					{{ t("admin.resend.submit") }}
				</button>
				<button
					v-if="resendSource === 'stored'"
					type="button"
					@click="clearResendKey"
					:disabled="resendSaving"
					class="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 flex-shrink-0"
				>
					{{ t("admin.resend.remove") }}
				</button>
			</form>
			<p v-if="resendMessage" class="text-sm text-green-600 dark:text-green-400 mt-2">{{ resendMessage }}</p>
			<p v-if="resendError" class="text-sm text-red-600 dark:text-red-400 mt-2">{{ resendError }}</p>
			<p class="text-xs text-gray-500 dark:text-gray-400 mt-3">{{ t("admin.resend.storageNote") }}</p>
		</div>

		<!-- Add another address you can sign in with. Not "create a user":
		     it belongs to you, and losing the first is why it exists. -->
		<div class="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 mb-8 border border-gray-200 dark:border-gray-700">
			<h2 class="text-xl font-bold text-gray-900 dark:text-white mb-1">{{ t("admin.registerUser.title") }}</h2>
			<p class="text-sm text-gray-600 dark:text-gray-400 mb-4">{{ t("admin.registerUser.description") }}</p>
			<form @submit.prevent="handleAddLogin" class="space-y-4">
				<div v-if="registerError" class="rounded-md bg-red-50 p-4">
					<p class="text-sm text-red-800">{{ registerError }}</p>
				</div>
				<div v-if="registerSuccess" class="rounded-md bg-green-50 p-4">
					<p class="text-sm text-green-800">{{ registerSuccess }}</p>
				</div>
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<label for="new-email" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
							{{ t("admin.registerUser.emailLabel") }}
						</label>
						<input
							id="new-email"
							v-model="newLogin.email"
							type="email"
							required
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-gray-900 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
							placeholder="user@example.com"
						/>
					</div>
					<div>
						<label for="new-password" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
							{{ t("admin.registerUser.passwordLabel") }}
						</label>
						<input
							id="new-password"
							v-model="newLogin.password"
							type="password"
							required
							minlength="8"
							class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent text-gray-900 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
							:placeholder="t('admin.registerUser.passwordPlaceholder')"
						/>
					</div>
				</div>
				<button
					type="submit"
					:disabled="registerLoading"
					class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
				>
					{{ registerLoading ? t("admin.registerUser.creating") : t("admin.registerUser.submit") }}
				</button>
			</form>
		</div>

		<!-- Your logins. Every row is you, so there is nothing to tell apart
		     and no role column: what used to be here was every account in the
		     deployment, root's address among them. -->
		<div class="bg-white dark:bg-gray-800 rounded-xl shadow-lg p-6 mb-8 border border-gray-200 dark:border-gray-700">
			<div class="flex items-center justify-between mb-1">
				<h2 class="text-xl font-bold text-gray-900 dark:text-white">{{ t("admin.users.title") }}</h2>
				<button
					@click="loadLogins"
					:disabled="loginsLoading"
					class="px-3 py-1 text-sm text-indigo-600 dark:text-indigo-400 hover:text-indigo-800 dark:hover:text-indigo-300 disabled:opacity-50"
				>
					{{ loginsLoading ? t("admin.users.loading") : t("admin.users.refresh") }}
				</button>
			</div>
			<p class="text-sm text-gray-600 dark:text-gray-400 mb-4">{{ t("admin.users.description") }}</p>

			<div v-if="loginsLoading && logins.length === 0" class="text-center py-8 text-gray-500">
				{{ t("admin.users.loadingUsers") }}
			</div>

			<ul v-else class="divide-y divide-gray-200 dark:divide-gray-700">
				<li
					v-for="login in logins"
					:key="login.id"
					class="py-3 flex flex-wrap items-center justify-between gap-3"
				>
					<div>
						<p class="text-sm text-gray-900 dark:text-gray-100">{{ login.email }}</p>
						<p class="text-xs text-gray-500 dark:text-gray-400">{{ formatListDate(login.createdAt) }}</p>
					</div>
					<button
						v-if="logins.length > 1"
						@click="removeLogin(login)"
						:disabled="removing === login.id"
						class="px-3 py-1 text-sm text-red-600 border border-red-200 rounded-lg hover:bg-red-50 dark:text-red-400 dark:border-red-900 dark:hover:bg-red-900/30 disabled:opacity-50"
					>
						{{ t("admin.users.remove") }}
					</button>
					<span v-else class="text-xs text-gray-500 dark:text-gray-400">
						{{ t("admin.users.onlyOne") }}
					</span>
				</li>
			</ul>
		</div>
	</div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import LanguageSwitcher from "@/components/LanguageSwitcher.vue";
import { useDateFormat } from "@/composables/useDateFormat";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import api from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { translateApiError } from "@/utils/apiError";

/**
 * One address you can sign in with. There is no role here and no flag: every
 * row on this screen is the same person -- you -- so there is nothing for a
 * role column to distinguish.
 */
interface Login {
	id: string;
	email: string;
	createdAt: number;
}

const router = useRouter();
const authStore = useAuthStore();
const { t } = useI18n();
const { formatListDate } = useDateFormat();

// Root manages people; its own mail settings and spare logins live on its own
// screen, so it has no reason to be here.
if (authStore.role === "root") {
	router.push("/root");
}

const newLogin = ref({ email: "", password: "" });
const registerLoading = ref(false);
const registerError = useLocalizedMessage();
const registerSuccess = useLocalizedMessage();

const logins = ref<Login[]>([]);
const loginsLoading = ref(false);
const removing = ref<string | null>(null);

const resendSource = ref<"stored" | "environment" | "none">("none");
const resendApiKeyInput = ref("");
const resendSaving = ref(false);
const resendMessage = useLocalizedMessage();
const resendError = useLocalizedMessage();

onMounted(() => {
	loadLogins();
	loadResendSettings();
});

async function loadResendSettings() {
	try {
		const response = await api.adminGetResendSettings();
		resendSource.value = response.data.source;
	} catch {
		resendSource.value = "none";
	}
}

async function applyResendKey(apiKey: string, done: () => string) {
	resendSaving.value = true;
	resendMessage.value = "";
	resendError.value = "";
	try {
		const response = await api.adminSetResendApiKey(apiKey);
		resendSource.value = response.data.source;
		resendApiKeyInput.value = "";
		resendMessage.value = done;
	} catch {
		resendError.value = () => t("admin.resend.failed");
	} finally {
		resendSaving.value = false;
	}
}

const saveResendKey = () =>
	applyResendKey(resendApiKeyInput.value.trim(), () => t("admin.resend.saved"));

function clearResendKey() {
	if (!confirm(t("admin.resend.confirmRemove"))) return;
	applyResendKey("", () => t("admin.resend.removed"));
}

/**
 * Adds another address to your own account.
 *
 * It used to create a separate account, which then had to be promoted by hand
 * -- two steps whose result the model has no word for. What it makes now is
 * yours from the moment it exists, carrying what you carry, reaching what you
 * reach.
 */
async function handleAddLogin() {
	registerLoading.value = true;
	registerError.value = "";
	registerSuccess.value = "";

	try {
		await api.addOwnLogin(newLogin.value.email, newLogin.value.password);
		const added = newLogin.value.email;
		registerSuccess.value = () =>
			t("admin.registerUser.successMessage", { email: added });
		newLogin.value = { email: "", password: "" };
		await loadLogins();
	} catch (error: any) {
		const fromApi = error.response?.data?.error;
		registerError.value = () =>
			fromApi || t("admin.registerUser.failedToCreate");
	} finally {
		registerLoading.value = false;
	}
}

async function loadLogins() {
	loginsLoading.value = true;
	try {
		const response = await api.listOwnLogins();
		logins.value = response.data;
	} catch (error: any) {
		console.error("Failed to load logins:", error);
	} finally {
		loginsLoading.value = false;
	}
}

/**
 * How a spare is replaced: add the new address, then remove the old one. The
 * Worker refuses the last one, and the button is hidden when there is only
 * one -- a person with no way in is a person nobody can reach.
 */
async function removeLogin(login: Login) {
	if (!window.confirm(t("admin.users.confirmRemove", { email: login.email }))) {
		return;
	}
	removing.value = login.id;
	try {
		await api.deleteOwnLogin(login.id);
		await loadLogins();
	} catch (e: any) {
		window.alert(
			translateApiError(e.response?.data?.error, t("admin.users.removeFailed")),
		);
	} finally {
		removing.value = null;
	}
}
</script>

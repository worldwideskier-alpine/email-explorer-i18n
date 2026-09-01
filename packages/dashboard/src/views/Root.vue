<template>
  <!-- The account list, and nothing else. There is no mailbox here, no
       message and no subject: root manages who may sign in, and is not a
       second pair of eyes on the mail. See routes/root.ts in the Worker. -->
  <div class="min-h-screen p-4 sm:p-8">
    <div class="max-w-5xl mx-auto">
      <div class="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div>
          <h1 class="text-2xl font-bold text-gray-900 dark:text-white">{{ t("root.title") }}</h1>
          <p class="text-sm text-gray-600 dark:text-gray-400 mt-1 max-w-2xl">{{ t("root.subtitle") }}</p>
        </div>
        <div class="flex items-center gap-2">
          <button
            @click="logout"
            class="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-300 dark:border-gray-600 dark:hover:bg-gray-700"
          >
            {{ t("home.logout") }}
          </button>
          <LanguageSwitcher />
        </div>
      </div>

      <div class="bg-white dark:bg-gray-800 rounded-xl shadow p-6 border border-gray-200 dark:border-gray-700 mb-6">
        <h2 class="text-lg font-medium text-gray-900 dark:text-white mb-4">{{ t("admin.registerUser.title") }}</h2>
        <form @submit.prevent="createAccount" class="flex flex-wrap items-end gap-4">
          <div>
            <label for="newEmail" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("admin.registerUser.emailLabel") }}</label>
            <input
              id="newEmail"
              v-model="newEmail"
              type="email"
              required
              class="mt-1 w-72 max-w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm p-2"
            />
          </div>
          <div>
            <label for="newPassword" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("admin.registerUser.passwordLabel") }}</label>
            <input
              id="newPassword"
              v-model="newPassword"
              type="password"
              required
              minlength="8"
              :placeholder="t('admin.registerUser.passwordPlaceholder')"
              class="mt-1 w-72 max-w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm p-2"
            />
          </div>
          <button
            type="submit"
            :disabled="busy"
            class="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {{ busy ? t("admin.registerUser.creating") : t("admin.registerUser.submit") }}
          </button>
        </form>
      </div>

      <div class="bg-white dark:bg-gray-800 rounded-xl shadow border border-gray-200 dark:border-gray-700 overflow-hidden">
        <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <h2 class="text-lg font-medium text-gray-900 dark:text-white">{{ t("admin.users.title") }}</h2>
          <button @click="load" class="text-sm text-indigo-600 dark:text-indigo-400 hover:underline">{{ t("admin.users.refresh") }}</button>
        </div>

        <p v-if="loading" class="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{{ t("admin.users.loadingUsers") }}</p>
        <p v-else-if="accounts.length === 0" class="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{{ t("admin.users.empty") }}</p>

        <ul v-else class="divide-y divide-gray-200 dark:divide-gray-700">
          <li v-for="account in accounts" :key="account.id" class="px-6 py-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p class="text-sm font-medium text-gray-900 dark:text-white break-all">{{ account.email }}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400">{{ roleLabel(account.role) }}</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  @click="resetPassword(account)"
                  :disabled="busy"
                  class="px-3 py-1.5 text-sm text-indigo-700 dark:text-indigo-300 border border-indigo-300 dark:border-indigo-700 rounded-md hover:bg-indigo-50 dark:hover:bg-indigo-900/30 disabled:opacity-50"
                >
                  {{ t("root.resetPassword") }}
                </button>
                <button
                  v-if="account.role !== 'root'"
                  @click="transfer(account)"
                  :disabled="busy"
                  class="px-3 py-1.5 text-sm text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-700 rounded-md hover:bg-amber-50 dark:hover:bg-amber-900/30 disabled:opacity-50"
                >
                  {{ t("root.transfer") }}
                </button>
                <button
                  v-if="account.role !== 'root'"
                  @click="removeAccount(account)"
                  :disabled="busy"
                  class="px-3 py-1.5 text-sm text-red-700 dark:text-red-300 border border-red-300 dark:border-red-700 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                >
                  {{ t("root.deleteAccount") }}
                </button>
              </div>
            </div>

            <!-- Which addresses this account looks after. Root moves them
                 between accounts; it does not open them. -->
            <div v-if="account.role !== 'root'" class="mt-3">
              <p class="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{{ t("admin.accessModal.mailboxIdLabel") }}</p>
              <div class="flex flex-wrap items-center gap-2">
                <span
                  v-for="mailbox in account.mailboxes"
                  :key="mailbox"
                  class="inline-flex items-center gap-2 px-2 py-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-md"
                >
                  {{ mailbox }}
                  <button
                    @click="unassign(account, mailbox)"
                    :disabled="busy"
                    class="text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
                  >
                    {{ t("admin.accessModal.revokeAccess") }}
                  </button>
                </span>
                <span v-if="account.mailboxes.length === 0" class="text-xs text-gray-400">—</span>
              </div>
              <form @submit.prevent="assign(account)" class="flex flex-wrap items-center gap-2 mt-2">
                <input
                  v-model="assignTo[account.id]"
                  type="text"
                  :placeholder="t('admin.accessModal.mailboxIdLabel')"
                  class="w-64 max-w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm text-sm p-1.5"
                />
                <button
                  type="submit"
                  :disabled="busy"
                  class="px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50"
                >
                  {{ t("admin.accessModal.grantAccess") }}
                </button>
              </form>
            </div>
          </li>
        </ul>
      </div>

      <p v-if="message" class="mt-4 text-sm text-green-600 dark:text-green-400">{{ message }}</p>
      <p v-if="error" class="mt-4 text-sm text-red-600 dark:text-red-400">{{ error }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import LanguageSwitcher from "@/components/LanguageSwitcher.vue";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import api from "@/services/api";
import { type AccountRole, useAuthStore } from "@/stores/auth";

interface Account {
	id: string;
	email: string;
	role: AccountRole;
	mailboxes: string[];
	createdAt: number;
}

const { t } = useI18n();
const router = useRouter();
const authStore = useAuthStore();

const accounts = ref<Account[]>([]);
const loading = ref(true);
const busy = ref(false);
const newEmail = ref("");
const newPassword = ref("");
const assignTo = ref<Record<string, string>>({});
// Stored as how to produce the text, not as the text: a message frozen at
// whichever language was current stays behind when the language changes.
const message = useLocalizedMessage();
const error = useLocalizedMessage();

const roleLabel = (role: AccountRole) =>
	role === "root"
		? t("root.roleRoot")
		: role === "admin"
			? t("admin.users.roleAdmin")
			: t("admin.users.roleUser");

async function load() {
	loading.value = true;
	try {
		accounts.value = (await api.listAccounts()).data ?? [];
	} finally {
		loading.value = false;
	}
}

async function createAccount() {
	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		const email = newEmail.value;
		await api.createAccount(email, newPassword.value);
		newEmail.value = "";
		newPassword.value = "";
		message.value = () => t("admin.registerUser.successMessage", { email });
		await load();
	} catch {
		error.value = () => t("admin.registerUser.failedToCreate");
	} finally {
		busy.value = false;
	}
}

async function resetPassword(account: Account) {
	const password = window.prompt(t("root.resetPassword"), "");
	if (!password) return;

	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		await api.setAccountPassword(account.id, password);
		message.value = () => t("admin.resend.saved");
	} catch {
		error.value = () => t("admin.registerUser.failedToCreate");
	} finally {
		busy.value = false;
	}
}

async function removeAccount(account: Account) {
	if (!window.confirm(t("root.confirmDelete", { email: account.email })))
		return;

	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		await api.deleteAccount(account.id);
		message.value = () => t("admin.resend.removed");
		await load();
	} catch {
		error.value = () => t("root.deleteFailed");
	} finally {
		busy.value = false;
	}
}

/**
 * Hands the role to somebody else. The handover path and the recovery path
 * at once -- and the last thing this account can do here, so it is worth
 * being asked about plainly.
 */
async function transfer(account: Account) {
	if (!window.confirm(t("root.confirmTransfer", { email: account.email }))) {
		return;
	}

	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		await api.transferRoot(account.id);
		// No longer root, so this screen is no longer reachable.
		window.location.assign("/");
	} catch {
		error.value = () => t("root.deleteFailed");
	} finally {
		busy.value = false;
	}
}

async function assign(account: Account) {
	const mailboxId = (assignTo.value[account.id] ?? "").trim();
	if (!mailboxId) return;

	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		await api.assignMailbox(account.id, mailboxId);
		assignTo.value[account.id] = "";
		message.value = () => t("admin.accessModal.grantSuccess");
		await load();
	} catch {
		error.value = () => t("admin.accessModal.failedToGrant");
	} finally {
		busy.value = false;
	}
}

async function unassign(account: Account, mailboxId: string) {
	if (
		!window.confirm(
			t("admin.accessModal.revokeConfirm", { email: account.email, mailboxId }),
		)
	) {
		return;
	}

	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		await api.unassignMailbox(account.id, mailboxId);
		message.value = () => t("admin.accessModal.revokeSuccess");
		await load();
	} catch {
		error.value = () => t("admin.accessModal.failedToRevoke");
	} finally {
		busy.value = false;
	}
}

async function logout() {
	await authStore.logout();
	router.push("/login");
}

onMounted(load);
</script>

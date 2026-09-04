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

      <!-- Whether the nightly run finished. Each mailbox records what happened
           to it, which answers "did my backup run" but not "did the run
           finish": a pass that never started and a pass that ran and found
           nothing to do leave the same absence on every mailbox. -->
      <div v-if="!maintenanceLoading" class="mb-6 text-sm">
        <p v-if="!maintenance" class="text-gray-500 dark:text-gray-400">
          {{ t("root.maintenance.never") }}
        </p>
        <p v-else-if="maintenance.finishedAt" class="text-gray-500 dark:text-gray-400">
          {{ t("root.maintenance.done", {
            at: formatFullDate(maintenance.startedAt),
            duration: finishedDuration,
            backups: maintenance.backups?.ran ?? 0,
            deleted: deletedCount,
          }) }}
        </p>
        <p v-else class="text-amber-700 dark:text-amber-400 font-semibold break-words">
          {{ t(stoppedKey, {
            at: formatFullDate(maintenance.startedAt),
            detail: stoppedDetail,
          }) }}
        </p>
      </div>

      <div class="bg-white dark:bg-gray-800 rounded-xl shadow p-6 border border-gray-200 dark:border-gray-700 mb-6">
        <h2 class="text-lg font-medium text-gray-900 dark:text-white mb-1">{{ t("root.create.title") }}</h2>
        <!-- Two different acts behind one form: "administrator" makes
             somebody new, "super administrator" adds another address to your
             own account. The second is a spare, not a second holder of the
             role -- the role belongs to the person, so every address you sign
             in with carries it, and that is the whole of succession here. -->
        <form @submit.prevent="createAccount" class="flex flex-wrap items-end gap-4">
          <div>
            <label for="newRole" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("root.create.roleLabel") }}</label>
            <select
              id="newRole"
              v-model="newRole"
              class="mt-1 w-72 max-w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm p-2"
            >
              <option value="admin">{{ t("root.roleAdmin") }}</option>
              <option value="root">{{ t("root.roleRoot") }}</option>
            </select>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400 w-72 max-w-full">
              {{ newRole === "root" ? t("root.create.roleRootHint") : t("root.create.roleAdminHint") }}
            </p>
          </div>
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

        <!-- One row per person, not per login. A person is the addresses
             they sign in with and nothing else -- there is no name to show
             -- so all of them are listed together. As separate rows they read
             as two strangers, each with its own delete button, when deleting
             a person is one act that takes all of it. -->
        <ul v-else class="divide-y divide-gray-200 dark:divide-gray-700">
          <li v-for="person in accounts" :key="person.personId" class="px-6 py-4">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p
                  v-for="email in person.emails"
                  :key="email"
                  class="text-sm font-medium text-gray-900 dark:text-white break-all"
                >{{ email }}</p>
                <p class="text-xs text-gray-500 dark:text-gray-400 mt-1">
                  {{ person.role === "root" ? t("root.roleRoot") : t("root.roleAdmin") }}
                </p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  v-if="person.role !== 'root'"
                  @click="removePerson(person)"
                  :disabled="busy"
                  class="px-3 py-1.5 text-sm text-red-700 dark:text-red-300 border border-red-300 dark:border-red-700 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                >
                  {{ t("root.deleteAccount") }}
                </button>
                <span v-else class="text-xs text-gray-500 dark:text-gray-400">
                  {{ t("root.thisIsYou") }}
                </span>
              </div>
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
import { computed, onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import LanguageSwitcher from "@/components/LanguageSwitcher.vue";
import { useDateFormat } from "@/composables/useDateFormat";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import api from "@/services/api";
import { type AccountRole, useAuthStore } from "@/stores/auth";
import {
	type MaintenanceRecord,
	maintenanceDeleted,
	maintenanceDuration,
	maintenanceStoppedDetail,
	maintenanceStoppedKey,
} from "@/utils/maintenance";

/** A person: the addresses they sign in with, and which role they hold. */
interface Person {
	personId: string;
	emails: string[];
	role: AccountRole;
	createdAt: number;
}

const { t } = useI18n();
const router = useRouter();
const authStore = useAuthStore();

const accounts = ref<Person[]>([]);
const loading = ref(true);
const busy = ref(false);
const newEmail = ref("");
const newPassword = ref("");
const newRole = ref<AccountRole>("admin");
// Stored as how to produce the text, not as the text: a message frozen at
// whichever language was current stays behind when the language changes.
const message = useLocalizedMessage();
const error = useLocalizedMessage();

const { formatFullDate } = useDateFormat();
const maintenance = ref<MaintenanceRecord | null>(null);
const maintenanceLoading = ref(true);

/**
 * How far an unfinished run got, which is the whole of what it says.
 *
 * The passes run in a fixed order and each writes down that it finished, so
 * the last one recorded is where the invocation ended. "It never got past the
 * backups" is a different problem from "it reached the purge", and the run
 * itself is the only place either can be seen.
 */
const stoppedKey = computed(() => maintenanceStoppedKey(maintenance.value));

// What the purge removed, and how long the whole run took. The first used to
// be the count of mailboxes visited, which read as messages; the second was
// never shown at all, and is the number that says how close the run is to the
// edge it was going over.
const deletedCount = computed(() => maintenanceDeleted(maintenance.value));
const finishedDuration = computed(() => maintenanceDuration(maintenance.value));

const stoppedDetail = computed(() =>
	maintenanceStoppedDetail(maintenance.value),
);

async function load() {
	loading.value = true;
	try {
		accounts.value = (await api.listAccounts()).data ?? [];
	} finally {
		loading.value = false;
	}
	try {
		maintenance.value = (await api.getMaintenance()).data ?? null;
	} finally {
		maintenanceLoading.value = false;
	}
}

/**
 * Creates a person, or adds an address to your own account.
 *
 * Which of the two is decided by the role. They look alike on this form and
 * are not alike at all: one puts somebody new in the deployment, the other
 * gives you a second way in. Nothing here adds an address to somebody else's
 * account -- their spare addresses are their own business.
 */
async function createAccount() {
	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		const email = newEmail.value;
		const role = newRole.value;
		await api.createAccount(email, newPassword.value, role);
		newEmail.value = "";
		newPassword.value = "";
		message.value = () =>
			role === "root"
				? t("root.create.addedOwn", { email })
				: t("admin.registerUser.successMessage", { email });
		await load();
	} catch {
		error.value = () => t("admin.registerUser.failedToCreate");
	} finally {
		busy.value = false;
	}
}

/**
 * Deletes a person and everything that was theirs.
 *
 * All of it: every login, every mailbox they registered, the messages in
 * them, and every nightly archive. This is how a deployment stops serving
 * somebody, so it has to actually stop -- mail left in the bucket still
 * costs, is still readable from the Cloudflare account, and appears on no
 * screen. Asked about twice, because it cannot be undone.
 */
async function removePerson(person: Person) {
	const who = person.emails.join(", ");
	if (!window.confirm(t("root.confirmDelete", { email: who }))) return;
	if (!window.confirm(t("root.confirmDeleteAgain", { email: who }))) return;

	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		await api.deletePerson(person.personId);
		message.value = () => t("root.deleted", { email: who });
		await load();
	} catch {
		error.value = () => t("root.deleteFailed");
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

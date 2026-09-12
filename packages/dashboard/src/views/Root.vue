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
      <!-- gray-600 rather than the gray-500 the same line takes inside a card.
           These two sit on the page itself, and the page is gray-100 in light
           mode, not white: measured, gray-500 lands at 4.39:1 there against a
           threshold of 4.5, where on white it is 4.84 and fine. The dark half
           is unchanged; it measured clean. -->
      <div v-if="!maintenanceLoading" class="mb-6 text-sm">
        <!-- A request that failed says so. Falling through to "it has never
             run" would be this screen's own failure mode: a confident
             sentence about a deployment nobody managed to ask. -->
        <p v-if="maintenanceUnreadable" class="text-amber-700 dark:text-amber-400 font-semibold">
          {{ t("root.maintenance.unreadable") }}
        </p>
        <p v-else-if="!maintenance" class="text-gray-600 dark:text-gray-400">
          {{ t("root.maintenance.never") }}
        </p>
        <!-- `finishedAt` alone is not "it went well": it is set on the failure
             paths too, so a night the purge crashed rendered as this calm grey
             line claiming 0 messages deleted. See maintenanceFinishedCleanly. -->
        <p v-else-if="finishedCleanly" class="text-gray-600 dark:text-gray-400">
          {{ t("root.maintenance.done", {
            at: formatFullDate(maintenance.startedAt),
            duration: finishedDuration,
            backups: maintenance.backups?.ran ?? 0,
            deleted: deletedCount,
          }) }}
        </p>
        <!-- Four of the six sentences have no `{detail}` slot, so what the run
             recorded is put after the sentence when it did not fit inside
             one. See maintenanceTrailingDetail. -->
        <p v-else class="text-amber-700 dark:text-amber-400 font-semibold break-words">
          {{ stoppedLine }}<span v-if="trailingDetail"> · {{ trailingDetail }}</span>
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
          <div class="w-full sm:w-auto">
            <label for="newRole" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("root.create.roleLabel") }}</label>
            <select
              id="newRole"
              v-model="newRole"
              class="mt-1 w-72 min-w-0 max-w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm p-2"
            >
              <option value="admin">{{ t("root.roleAdmin") }}</option>
              <option value="root">{{ t("root.roleRoot") }}</option>
            </select>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400 w-72 max-w-full">
              {{ newRole === "root" ? t("root.create.roleRootHint") : t("root.create.roleAdminHint") }}
            </p>
          </div>
          <div class="w-full sm:w-auto">
            <label for="newEmail" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("admin.registerUser.emailLabel") }}</label>
            <input
              id="newEmail"
              v-model="newEmail"
              type="email"
              required
              class="mt-1 w-72 max-w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm p-2"
            />
          </div>
          <div class="w-full sm:w-auto">
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
        <!-- Before "no users found", which on this screen is never true: you
             are signed in as one of them. It was what a failed request said. -->
        <p v-else-if="accountsUnreadable" class="px-6 py-4 text-sm text-amber-700 dark:text-amber-400 font-semibold">{{ t("root.accountsUnreadable") }}</p>
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
              <!-- The lock, then the delete, in that order and never both.
                   Deleting a person is the largest irreversible act here, and
                   it sat one touch from the refresh link. It is the same
                   two-step a mailbox has had all along; see
                   isPersonDeletionLocked in the Worker. -->
              <div class="flex flex-wrap items-center gap-3">
                <template v-if="person.role !== 'root'">
                  <label class="flex items-center gap-2 cursor-pointer">
                    <span class="text-xs text-gray-600 dark:text-gray-400">{{ t("root.lock.label") }}</span>
                    <span class="relative inline-flex items-center flex-shrink-0">
                      <input
                        type="checkbox"
                        :checked="person.deletionLocked"
                        :disabled="busy"
                        @change="toggleLock(person)"
                        class="sr-only peer"
                      />
                      <span class="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 dark:peer-focus:ring-indigo-800 rounded-full peer dark:bg-gray-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:after:border-gray-600 peer-checked:bg-indigo-600 peer-disabled:opacity-50"></span>
                    </span>
                  </label>
                  <span
                    v-if="person.deletionLocked"
                    class="text-xs text-gray-500 dark:text-gray-400 flex items-center gap-1.5"
                  >
                    <svg class="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                    {{ t("root.lock.lockedHint") }}
                  </span>
                  <button
                    v-else
                    @click="removePerson(person)"
                    :disabled="busy"
                    class="px-3 py-1.5 text-sm text-red-700 dark:text-red-300 border border-red-300 dark:border-red-700 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
                  >
                    {{ t("root.deleteAccount") }}
                  </button>
                </template>
                <span v-else class="text-xs text-gray-500 dark:text-gray-400">
                  {{ t("root.thisIsYou") }}
                </span>
              </div>
            </div>
          </li>
        </ul>
      </div>

      <!-- Storage housekeeping, which is root's for the same reason the
           nightly record is: the bucket belongs to the deployment rather than
           to a mailbox, and an administrator told "there are objects here
           nothing can reach" could do nothing about it. Counts only -- this
           screen never names a file, a mailbox or an address. -->
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow p-6 border border-gray-200 dark:border-gray-700 mt-6">
        <h2 class="text-lg font-medium text-gray-900 dark:text-white">{{ t("root.attachments.title") }}</h2>
        <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">{{ t("root.attachments.explain") }}</p>

        <button
          @click="scanAttachments"
          :disabled="sweeping"
          class="mt-4 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200 dark:border-gray-600 dark:hover:bg-gray-600"
        >
          {{ sweeping ? t("root.attachments.working") : t("root.attachments.scan") }}
        </button>

        <!-- A failed request says so rather than falling through to "nothing
             to clean up", which is the one sentence it must not borrow. -->
        <p v-if="sweepUnreadable" class="mt-3 text-sm text-amber-700 dark:text-amber-400 font-semibold">
          {{ t("root.attachments.unreadable") }}
        </p>
        <div v-else-if="sweep" class="mt-3 text-sm">
          <p class="text-gray-600 dark:text-gray-400">
            {{ t("root.attachments.summary", { objects: sweep.objects, size: formatBytes(sweep.bytes) }) }}
          </p>

          <p v-if="sweep.misnamed === 0 && sweep.unclaimed === 0" class="mt-2 text-gray-500 dark:text-gray-400">
            {{ t("root.attachments.clean") }}
          </p>

          <!-- Repairable: the message is still there and can be opened, and
               only the name these bytes are filed under is wrong. -->
          <div v-if="sweep.misnamed > 0" class="mt-4">
            <p class="text-amber-700 dark:text-amber-400 font-semibold">
              {{ t("root.attachments.misnamed", { count: sweep.misnamed, size: formatBytes(sweep.misnamedBytes) }) }}
            </p>
            <button
              @click="repairAttachments"
              :disabled="sweeping"
              class="mt-2 px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
            >
              {{ t("root.attachments.repair") }}
            </button>
          </div>

          <!-- The destructive one, and the only thing on this screen that can
               take something somebody still wants: an unlisted mailbox's mail
               reads exactly like a deletion's leftovers. -->
          <div v-if="sweep.unclaimed > 0" class="mt-4">
            <p class="text-amber-700 dark:text-amber-400 font-semibold">
              {{ t("root.attachments.unclaimed", { count: sweep.unclaimed, size: formatBytes(sweep.unclaimedBytes) }) }}
            </p>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">{{ t("root.attachments.unclaimedWarning") }}</p>
            <button
              @click="purgeAttachments"
              :disabled="sweeping"
              class="mt-2 px-4 py-2 text-sm text-red-700 dark:text-red-300 border border-red-300 dark:border-red-700 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
            >
              {{ t("root.attachments.purge") }}
            </button>
          </div>
        </div>
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
import { formatBytes } from "@/utils/attachments";
import {
	type MaintenanceRecord,
	maintenanceDeleted,
	maintenanceDuration,
	maintenanceFinishedCleanly,
	maintenanceStoppedDetail,
	maintenanceStoppedKey,
	maintenanceTrailingDetail,
} from "@/utils/maintenance";

/** A person: the addresses they sign in with, and which role they hold. */
interface Person {
	personId: string;
	emails: string[];
	role: AccountRole;
	createdAt: number;
	/** Protected from deletion. Absent means protected; see the Worker. */
	deletionLocked: boolean;
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
// Set when the request failed, which is not the same as there being nothing
// to report and must not be told as if it were. See load().
const maintenanceUnreadable = ref(false);
const accountsUnreadable = ref(false);

// Whether the run may be told as simply done. `finishedAt` alone is not that:
// it is set on the failure paths too, so a night a pass crashed came out as
// the calm grey line. See maintenanceFinishedCleanly.
const finishedCleanly = computed(() =>
	maintenanceFinishedCleanly(maintenance.value),
);

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

// The sentence, and then what would not fit in it. A run cut off after a pass
// that recorded an error gets the sentence for a run that stopped -- which is
// the true one, and has nowhere to say what the error was.
const stoppedLine = computed(() =>
	t(stoppedKey.value, {
		at: maintenance.value ? formatFullDate(maintenance.value.startedAt) : "",
		duration: finishedDuration.value,
		detail: stoppedDetail.value,
	}),
);
const trailingDetail = computed(() =>
	maintenanceTrailingDetail(stoppedLine.value, maintenance.value),
);

/** Counts by state, and nothing that says whose mail any of it is. */
interface AttachmentSweep {
	objects: number;
	bytes: number;
	matched: number;
	misnamed: number;
	misnamedBytes: number;
	unclaimed: number;
	unclaimedBytes: number;
	unreadable: number;
}

const sweep = ref<AttachmentSweep | null>(null);
const sweeping = ref(false);
const sweepUnreadable = ref(false);

/**
 * Not run on load, unlike the two requests above.
 *
 * It walks every attachment object in the bucket and asks every mailbox what
 * it holds, which is a real amount of work for a screen whose job is the
 * account list. Opening this page should not do it; pressing the button
 * should.
 */
async function scanAttachments() {
	sweeping.value = true;
	sweepUnreadable.value = false;
	try {
		sweep.value = (await api.sweepAttachments()).data ?? null;
	} catch {
		sweep.value = null;
		sweepUnreadable.value = true;
	} finally {
		sweeping.value = false;
	}
}

/**
 * Both actions end by surveying again, so what the screen shows is what the
 * bucket is now rather than what it was before the button was pressed. Each
 * call is also capped, and `remaining` is how the cap is said out loud: press
 * again.
 */
async function repairAttachments() {
	message.value = "";
	error.value = "";
	sweeping.value = true;
	try {
		const result = (await api.repairAttachments()).data;
		message.value = () =>
			t("root.attachments.repaired", {
				count: result?.repaired ?? 0,
				remaining: result?.remaining ?? 0,
			});
	} catch {
		error.value = () => t("root.attachments.failed");
	} finally {
		sweeping.value = false;
	}
	await scanAttachments();
}

async function purgeAttachments() {
	if (!sweep.value) return;
	// Asked once, in the words that say what cannot be told apart. The screen
	// has already printed the warning; this is the press that cannot be undone.
	if (
		!window.confirm(
			t("root.attachments.confirmPurge", { count: sweep.value.unclaimed }),
		)
	) {
		return;
	}
	message.value = "";
	error.value = "";
	sweeping.value = true;
	try {
		const result = (await api.purgeAttachments()).data;
		message.value = () =>
			t("root.attachments.purged", {
				count: result?.deleted ?? 0,
				size: formatBytes(result?.bytes ?? 0),
				remaining: result?.remaining ?? 0,
			});
	} catch {
		error.value = () => t("root.attachments.failed");
	} finally {
		sweeping.value = false;
	}
	await scanAttachments();
}

/**
 * Two requests, and neither may answer for the other.
 *
 * They used to be two `try`/`finally` blocks with no `catch` between them, so
 * a rejected account list threw out of here before the second one ran and
 * left `maintenanceLoading` true forever: the whole maintenance block is
 * behind `v-if="!maintenanceLoading"`, so the one line that exists to say the
 * nightly run failed was simply absent, with nothing on the screen to say a
 * request had failed at all.
 *
 * And each failure has to say so rather than fall back to the emptiness it
 * cannot tell itself from. An unread record is not "it has never run", and an
 * unread account list is not "no users found" -- on this screen there is
 * always at least one, so that one is never true. Both were confident
 * sentences about a deployment nobody had managed to ask.
 */
async function load() {
	loading.value = true;
	accountsUnreadable.value = false;
	try {
		// `deletionLocked !== false` rather than a plain read, matching the
		// Worker: a row from a deployment that predates the lock has no flag,
		// and the only safe reading of an absent one is "protected".
		accounts.value = ((await api.listAccounts()).data ?? []).map(
			(person: Person) => ({
				...person,
				deletionLocked: person.deletionLocked !== false,
			}),
		);
	} catch {
		accounts.value = [];
		accountsUnreadable.value = true;
	} finally {
		loading.value = false;
	}

	maintenanceUnreadable.value = false;
	try {
		maintenance.value = (await api.getMaintenance()).data ?? null;
	} catch {
		maintenance.value = null;
		maintenanceUnreadable.value = true;
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
 * Turns one person's deletion lock on or off.
 *
 * Unlocking asks first, and locking does not: one direction arms the button
 * that cannot be undone, the other disarms it, and a confirmation on the safe
 * direction only teaches people to dismiss confirmations.
 *
 * The row is reloaded from the Worker rather than assumed: the checkbox
 * showing a state the server does not hold is exactly how a lock stops
 * meaning anything.
 */
async function toggleLock(person: Person) {
	const next = !person.deletionLocked;
	if (!next) {
		const who = person.emails.join(", ");
		if (!window.confirm(t("root.lock.confirmUnlock", { email: who }))) {
			// Nothing was sent, but the checkbox has already drawn itself in
			// the new position; reloading puts it back where the truth is.
			await load();
			return;
		}
	}

	busy.value = true;
	message.value = "";
	error.value = "";
	try {
		await api.setPersonDeletionLock(person.personId, next);
	} catch {
		error.value = () => t("root.lock.failed");
	} finally {
		busy.value = false;
		await load();
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

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
              class="mt-1 w-72 border min-w-0 max-w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm h-10 px-2"
            >
              <option value="admin">{{ t("root.roleAdmin") }}</option>
              <option value="root">{{ t("root.roleRoot") }}</option>
            </select>
          </div>
          <div class="w-full sm:w-auto">
            <label for="newEmail" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("admin.registerUser.emailLabel") }}</label>
            <input
              id="newEmail"
              autocomplete="off"
              v-model="newEmail"
              type="email"
              required
              class="mt-1 w-72 border max-w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm h-10 px-2"
            />
          </div>
          <div class="w-full sm:w-auto">
            <label for="newPassword" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("admin.registerUser.passwordLabel") }}</label>
            <input
              id="newPassword"
              autocomplete="new-password"
              v-model="newPassword"
              type="password"
              required
              minlength="8"
              :placeholder="t('admin.registerUser.passwordPlaceholder')"
              class="mt-1 w-72 border max-w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm h-10 px-2"
            />
          </div>
          <!-- A spare of your own is the role itself, so it asks for your
               password; somebody holding only your session cannot mint one. -->
          <div v-if="newRole === 'root'" class="w-full sm:w-auto">
            <label for="rootCurrentPassword" class="block text-sm font-medium text-gray-700 dark:text-gray-300">{{ t("account.currentPassword") }}</label>
            <input
              id="rootCurrentPassword"
              v-model="currentPassword"
              type="password"
              required
              autocomplete="current-password"
              class="mt-1 w-72 border max-w-full bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 rounded-md shadow-sm sm:text-sm h-10 px-2"
            />
          </div>
          <button
            type="submit"
            :disabled="busy"
            class="px-4 py-2 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >
            {{ busy ? t("admin.registerUser.creating") : t("admin.registerUser.submit") }}
          </button>
          <!-- On a line of its own: under the selector it made that column
               taller than the others, and the row, aligned on its bottom
               edge, lifted the selector above the two fields beside it. -->
          <p class="basis-full -mt-2 text-xs text-gray-500 dark:text-gray-400">
            {{ newRole === "root" ? t("root.create.roleRootHint") : t("root.create.roleAdminHint") }}
          </p>
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
              <div class="min-w-0">
                <!-- Each login with its own "change password": the way back in
                     for somebody who has lost theirs, root's own spare
                     included, without any mail. It asks for root's password,
                     because setting somebody's password is taking their
                     account. -->
                <div v-for="login in loginsOf(person)" :key="login.id" class="mb-1">
                  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <p class="text-sm font-medium text-gray-900 dark:text-white break-all">{{ login.email }}</p>
                    <button
                      v-if="login.id"
                      type="button"
                      @click="openPasswordFor(login.id)"
                      class="text-xs text-indigo-700 dark:text-indigo-300 hover:underline"
                    >{{ t("account.changePassword.title") }}</button>
                  </div>
                  <form
                    v-if="passwordFor === login.id"
                    @submit.prevent="setPassword(login.id)"
                    class="mt-2 flex flex-wrap items-end gap-2"
                  >
                    <div>
                      <label :for="`pw-new-${login.id}`" class="block text-xs text-gray-600 dark:text-gray-400">{{ t("account.changePassword.newPassword") }}</label>
                      <input
                        :id="`pw-new-${login.id}`"
                        v-model="passwordNew"
                        type="password"
                        minlength="8"
                        required
                        autocomplete="new-password"
                        class="mt-1 w-full max-w-[14rem] px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      />
                    </div>
                    <div>
                      <label :for="`pw-own-${login.id}`" class="block text-xs text-gray-600 dark:text-gray-400">{{ t("account.currentPassword") }}</label>
                      <input
                        :id="`pw-own-${login.id}`"
                        v-model="passwordOwn"
                        type="password"
                        required
                        autocomplete="current-password"
                        class="mt-1 w-full max-w-[14rem] px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                      />
                    </div>
                    <button
                      type="submit"
                      :disabled="busy"
                      class="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
                    >{{ t("account.changePassword.submit") }}</button>
                  </form>
                  <p v-if="passwordResultFor === login.id && passwordResult" class="mt-1 text-xs text-green-700 dark:text-green-400">{{ passwordResult }}</p>
                  <p v-if="passwordResultFor === login.id && passwordError" class="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">{{ passwordError }}</p>
                </div>
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
                  <div class="flex items-center gap-2">
                    <!-- A real `<label for>`, which is what was here before
                         the switch became a button and what a `@click` on a
                         span is not: the words name the control to a screen
                         reader, and the browser forwards a press on them to
                         it. The words are the larger target of the two, and
                         on a phone they are the one a thumb finds. -->
                    <label
                      :for="`lock-${person.personId}`"
                      class="text-xs text-gray-600 dark:text-gray-400 cursor-pointer select-none"
                    >{{ t("root.lock.label") }}</label>
                    <ToggleSwitch
                      :id="`lock-${person.personId}`"
                      :on="person.deletionLocked"
                      :disabled="busy"
                      :label="t('root.lock.label')"
                      @toggle="toggleLock(person)"
                    />
                  </div>
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

      <!-- Where password-reset mail comes from. It was a string in the
           source, which every fork inherited -- so a fork sent its resets as
           this deployment's address and they never arrived. Set here, it is
           this deployment's own. -->
      <div class="bg-white dark:bg-gray-800 rounded-xl shadow p-6 border border-gray-200 dark:border-gray-700 mt-6">
        <h2 class="text-lg font-medium text-gray-900 dark:text-white">{{ t("root.recovery.title") }}</h2>
        <p class="text-sm text-gray-600 dark:text-gray-400 mt-1">{{ t("root.recovery.description") }}</p>
        <p v-if="recovery" class="mt-3 text-sm" :class="recovery.enabled ? 'text-gray-700 dark:text-gray-300' : 'text-amber-700 dark:text-amber-400 font-semibold'">
          <template v-if="recovery.setByDeployment">{{ t("root.recovery.byDeployment") }}</template>
          <template v-else-if="recovery.fromEmail">{{ t("root.recovery.current", { address: recovery.fromEmail }) }}</template>
          <template v-else>{{ t("root.recovery.off") }}</template>
        </p>
        <form @submit.prevent="saveRecovery" class="mt-3 flex flex-wrap items-center gap-2">
          <label for="recoveryFrom" class="sr-only">{{ t("root.recovery.title") }}</label>
          <input
            id="recoveryFrom"
            autocomplete="off"
            v-model="recoveryInput"
            type="email"
            placeholder="noreply@example.com"
            class="w-full max-w-xs px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
          />
          <button
            type="submit"
            :disabled="recoverySaving || !recoveryInput.trim()"
            class="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50"
          >{{ t("admin.resend.submit") }}</button>
          <button
            v-if="recovery?.fromEmail"
            type="button"
            @click="clearRecovery"
            :disabled="recoverySaving"
            class="px-4 py-2 text-sm text-red-700 dark:text-red-300 border border-red-300 dark:border-red-700 rounded-md hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
          >{{ t("admin.resend.remove") }}</button>
        </form>
        <p v-if="recoveryMessage" class="mt-2 text-sm text-green-700 dark:text-green-400">{{ recoveryMessage }}</p>
        <p v-if="recoveryError" class="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{{ recoveryError }}</p>
      </div>

      <!-- Root's own sending key, beside the address its resets come from:
           the two together decide whether root's own reset mail can go out.
           Root cannot open /admin, which is where this used to be only. -->
      <ResendKeyCard plain class="mt-6" />

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
import ResendKeyCard from "@/components/ResendKeyCard.vue";
import ToggleSwitch from "@/components/ToggleSwitch.vue";
import { useDateFormat } from "@/composables/useDateFormat";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import api from "@/services/api";
import { type AccountRole, useAuthStore } from "@/stores/auth";
import { translateApiError } from "@/utils/apiError";
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
	/** The same addresses with the ids a password is set against. */
	logins?: { id: string; email: string }[];
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
const currentPassword = ref("");
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

/** Each login, with its id when the Worker gave one. */
const loginsOf = (person: Person) =>
	person.logins ?? person.emails.map((email) => ({ id: "", email }));

const passwordFor = ref<string | null>(null);
const passwordNew = ref("");
const passwordOwn = ref("");
const passwordResultFor = ref<string | null>(null);
const passwordResult = useLocalizedMessage();
const passwordError = useLocalizedMessage();

function openPasswordFor(userId: string) {
	passwordFor.value = passwordFor.value === userId ? null : userId;
	passwordNew.value = "";
	passwordOwn.value = "";
	passwordResult.value = "";
	passwordError.value = "";
}

async function setPassword(userId: string) {
	busy.value = true;
	passwordResultFor.value = userId;
	passwordResult.value = "";
	passwordError.value = "";
	try {
		await api.setAccountPassword(userId, passwordNew.value, passwordOwn.value);
		passwordFor.value = null;
		passwordResult.value = () => t("account.changePassword.done");
	} catch (e: any) {
		const fromApi = e?.response?.data?.error;
		passwordError.value = () =>
			translateApiError(fromApi, t("account.changePassword.failed"));
	} finally {
		passwordNew.value = "";
		passwordOwn.value = "";
		busy.value = false;
	}
}

interface RecoverySender {
	fromEmail: string | null;
	setByDeployment: boolean;
	enabled: boolean;
}
const recovery = ref<RecoverySender | null>(null);
const recoveryInput = ref("");
const recoverySaving = ref(false);
const recoveryMessage = useLocalizedMessage();
const recoveryError = useLocalizedMessage();

async function loadRecovery() {
	try {
		recovery.value = (await api.getRecoverySender()).data ?? null;
		recoveryInput.value = recovery.value?.fromEmail ?? "";
	} catch {
		recovery.value = null;
	}
}

async function writeRecovery(fromEmail: string, done: string) {
	recoverySaving.value = true;
	recoveryMessage.value = "";
	recoveryError.value = "";
	try {
		recovery.value = (await api.setRecoverySender(fromEmail)).data ?? null;
		recoveryInput.value = recovery.value?.fromEmail ?? "";
		recoveryMessage.value = () => t(done);
	} catch (e: any) {
		const fromApi = e?.response?.data?.error;
		recoveryError.value = () =>
			translateApiError(fromApi, t("admin.resend.failed"));
	} finally {
		recoverySaving.value = false;
	}
}

const saveRecovery = () =>
	writeRecovery(recoveryInput.value.trim(), "admin.resend.saved");
const clearRecovery = () => writeRecovery("", "admin.resend.removed");

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
		await api.createAccount(
			email,
			newPassword.value,
			role,
			role === "root" ? currentPassword.value : undefined,
		);
		newEmail.value = "";
		newPassword.value = "";
		currentPassword.value = "";
		message.value = () =>
			role === "root"
				? t("root.create.addedOwn", { email })
				: t("admin.registerUser.successMessage", { email });
		await load();
	} catch (e: any) {
		const fromApi = e?.response?.data?.error;
		error.value = () =>
			translateApiError(fromApi, t("admin.registerUser.failedToCreate"));
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
 * The row is reloaded from the Worker rather than assumed: a switch showing a
 * state the server does not hold is exactly how a lock stops meaning
 * anything. Dismissing the question needs no reload at all -- the switch is
 * drawn from `person.deletionLocked`, which nothing has touched. That is the
 * whole reason it is a `ToggleSwitch` and not a checkbox; see that component.
 */
async function toggleLock(person: Person) {
	const next = !person.deletionLocked;
	if (!next) {
		const who = person.emails.join(", ");
		if (!window.confirm(t("root.lock.confirmUnlock", { email: who }))) return;
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

onMounted(() => {
	load();
	loadRecovery();
});
</script>

<template>
  <label :class="floating ? 'fixed top-4 left-4 z-40' : 'ml-1 sm:ml-2'">
    <span class="sr-only">{{ t("header.language") }}</span>
    <select
      :value="locale"
      @change="setLocale(($event.target as HTMLSelectElement).value as Locale)"
      class="text-sm border border-gray-300 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg px-2 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
    >
      <option value="ja">日本語</option>
      <option value="en">English</option>
      <option value="de">Deutsch</option>
    </select>
  </label>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { type Locale, setLocale } from "@/i18n";

/**
 * The one language control, in two placements. A page with a row of actions
 * of its own -- the mailbox header, the mailbox list, the account and admin
 * pages -- puts it in that row. The rest are single centred cards with
 * nothing in the corners, so it pins itself to one.
 *
 * Top left, not top right: Toast is `fixed top-4 right-4`, and a toast would
 * sit straight on top of it.
 *
 * A page you cannot change the language from is worse than it sounds here:
 * sign-in and password reset are exactly where someone who does not read the
 * default language arrives first, and the reset mail is sent in whatever
 * locale that page was showing.
 */
defineProps<{ floating?: boolean }>();

const { t, locale } = useI18n();
</script>

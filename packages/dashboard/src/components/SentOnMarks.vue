<template>
  <!-- Signs, not controls: each arrow is hidden from assistive technology
       and the same words are read out instead, with when it happened. -->
  <span v-if="marks.length" class="inline-flex flex-shrink-0 items-center gap-0.5">
    <span v-for="mark in marks" :key="mark.kind" class="inline-flex" :class="mark.colour" :title="mark.label">
      <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
        <path fill-rule="evenodd" :d="mark.path" clip-rule="evenodd" />
      </svg>
      <span class="sr-only">{{ mark.label }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useDateFormat } from "@/composables/useDateFormat";

const props = defineProps<{
	repliedAt?: string | null;
	forwardedAt?: string | null;
}>();
const { t } = useI18n();
const { formatFullDate } = useDateFormat();

// A reply turns back to the sender, a forward goes on to someone else: the
// same arrow, one each way, in two colours so they are told apart at a glance.
const REPLY =
	"M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z";
const FORWARD =
	"M12.207 2.232a.75.75 0 0 0 .025 1.06l4.146 3.958H6.375a5.375 5.375 0 0 0 0 10.75H9.25a.75.75 0 0 0 0-1.5H6.375a3.875 3.875 0 0 1 0-7.75h10.003l-4.146 3.957a.75.75 0 0 0 1.036 1.085l5.5-5.25a.75.75 0 0 0 0-1.085l-5.5-5.25a.75.75 0 0 0-1.06.025Z";

// Computed, so the words follow a change of language while the list is open.
const marks = computed(() => [
	...(props.repliedAt
		? [
				{
					kind: "replied",
					path: REPLY,
					colour: "text-indigo-600 dark:text-indigo-400",
					label: t("emailList.replied", {
						at: formatFullDate(props.repliedAt),
					}),
				},
			]
		: []),
	...(props.forwardedAt
		? [
				{
					kind: "forwarded",
					path: FORWARD,
					colour: "text-emerald-600 dark:text-emerald-400",
					label: t("emailList.forwarded", {
						at: formatFullDate(props.forwardedAt),
					}),
				},
			]
		: []),
]);
</script>

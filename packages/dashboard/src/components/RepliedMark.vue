<template>
  <!-- A sign, not a control: the arrow is hidden from assistive technology
       and the same words are read out instead, with when it was answered. -->
  <span class="inline-flex flex-shrink-0 text-indigo-600 dark:text-indigo-400" :title="label">
    <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
      <path fill-rule="evenodd" d="M7.793 2.232a.75.75 0 0 1-.025 1.06L3.622 7.25h10.003a5.375 5.375 0 0 1 0 10.75H10.75a.75.75 0 0 1 0-1.5h2.875a3.875 3.875 0 0 0 0-7.75H3.622l4.146 3.957a.75.75 0 0 1-1.036 1.085l-5.5-5.25a.75.75 0 0 1 0-1.085l5.5-5.25a.75.75 0 0 1 1.06.025Z" clip-rule="evenodd" />
    </svg>
    <span class="sr-only">{{ label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useDateFormat } from "@/composables/useDateFormat";

const props = defineProps<{ at: string }>();
const { t } = useI18n();
const { formatFullDate } = useDateFormat();

// Computed, so the words follow a change of language while the list is open.
const label = computed(() =>
	t("emailList.replied", { at: formatFullDate(props.at) }),
);
</script>

<template>
  <div class="bg-white dark:bg-gray-800 shadow-md rounded-lg">
    <div class="p-4 border-b border-gray-200 dark:border-gray-700">
      <h1 class="text-xl font-semibold text-gray-900 dark:text-white">{{ t("contacts.title") }}</h1>
    </div>
    <div v-if="loadFailed && contacts.length === 0" class="p-8 text-center" role="alert">
      <p class="text-gray-700 dark:text-gray-300 mb-4">{{ t("common.loadFailed") }}</p>
      <button
        @click="loadContacts"
        class="px-4 py-2 text-sm font-medium text-indigo-700 bg-indigo-50 rounded-lg hover:bg-indigo-100 dark:text-indigo-300 dark:bg-gray-700 dark:hover:bg-gray-600 transition-colors"
      >
        {{ t("common.retry") }}
      </button>
    </div>
    <ul class="divide-y divide-gray-200 dark:divide-gray-700">
      <li v-for="contact in contacts" :key="contact.id" class="p-4">
        <p class="text-sm font-medium text-gray-900 dark:text-white">{{ contact.name }}</p>
        <p class="text-sm text-gray-500 dark:text-gray-400">{{ contact.email }}</p>
      </li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { onMounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useContactStore } from "@/stores/contacts";

const { t } = useI18n();
const contactStore = useContactStore();
const { contacts } = storeToRefs(contactStore);
const route = useRoute();

/** A list that could not be fetched, rather than one with nobody in it. */
const loadFailed = ref(false);

const loadContacts = async () => {
	loadFailed.value = false;
	try {
		await contactStore.fetchContacts(route.params.mailboxId as string);
	} catch {
		loadFailed.value = true;
	}
};

onMounted(loadContacts);
</script>

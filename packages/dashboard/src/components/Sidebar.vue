<template>
  <div
    v-if="isSidebarOpen"
    @click="uiStore.closeSidebar()"
    class="fixed inset-0 bg-black/50 z-30 md:hidden"
  ></div>
  <!-- The slide-away is confined to the narrow layout with max-md. On a wide
       screen the aside is a static flex child and must not be transformed at
       all: an unscoped `rtl:translate-x-full` outranked the `md:translate-x-0`
       meant to cancel it, and the sidebar disappeared off the edge on every
       right-to-left language at desktop width. -->
  <aside
    class="w-72 bg-gradient-to-b from-white to-gray-50 dark:from-gray-800 dark:to-gray-900 p-6 border-e border-gray-200 dark:border-gray-700 flex flex-col fixed inset-y-0 start-0 z-40 transition-transform duration-300 md:static md:z-auto"
    :class="isSidebarOpen ? '' : 'max-md:-translate-x-full max-md:rtl:translate-x-full'"
  >
    <button
      @click="uiStore.closeSidebar()"
      class="md:hidden self-end mb-4 p-2 -me-2 text-gray-500 hover:text-indigo-600 dark:text-gray-400 dark:hover:text-indigo-400 rounded-lg hover:bg-indigo-50 dark:hover:bg-gray-700/50 transition-all duration-200"
      :title="t('sidebar.toggleMenu')"
    >
      <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
    <button
      @click="openComposeModal"
      class="w-full mb-8 px-6 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl shadow-lg hover:shadow-xl hover:from-indigo-700 hover:to-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 transform hover:scale-105 transition-all duration-200 font-semibold flex items-center justify-center gap-2"
    >
      <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
      </svg>
      {{ t("sidebar.compose") }}
    </button>
    <nav class="flex-1 overflow-y-auto">
      <ul class="space-y-1">
        <li>
          <router-link 
            :to="{ name: 'EmailList', params: { mailboxId: route.params.mailboxId, folder: 'inbox' } }" 
            class="flex items-center gap-3 py-3 px-4 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-indigo-50 dark:hover:bg-gray-700/50 transition-all duration-200 group"
            active-class="bg-gradient-to-r from-indigo-100 to-purple-50 dark:from-indigo-900/30 dark:to-purple-900/30 text-indigo-700 dark:text-indigo-300 font-semibold shadow-sm"
          >
            <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
            </svg>
            <span>{{ t("sidebar.inbox") }}</span>
          </router-link>
        </li>
        <li>
          <router-link 
            :to="{ name: 'EmailList', params: { mailboxId: route.params.mailboxId, folder: 'sent' } }" 
            class="flex items-center gap-3 py-3 px-4 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-indigo-50 dark:hover:bg-gray-700/50 transition-all duration-200 group"
            active-class="bg-gradient-to-r from-indigo-100 to-purple-50 dark:from-indigo-900/30 dark:to-purple-900/30 text-indigo-700 dark:text-indigo-300 font-semibold shadow-sm"
          >
            <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
            <span>{{ t("sidebar.sent") }}</span>
          </router-link>
        </li>
        <li>
          <router-link 
            :to="{ name: 'EmailList', params: { mailboxId: route.params.mailboxId, folder: 'draft' } }" 
            class="flex items-center gap-3 py-3 px-4 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-indigo-50 dark:hover:bg-gray-700/50 transition-all duration-200 group"
            active-class="bg-gradient-to-r from-indigo-100 to-purple-50 dark:from-indigo-900/30 dark:to-purple-900/30 text-indigo-700 dark:text-indigo-300 font-semibold shadow-sm"
          >
            <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            <span>{{ t("sidebar.draft") }}</span>
          </router-link>
        </li>
        <li>
          <router-link 
            :to="{ name: 'EmailList', params: { mailboxId: route.params.mailboxId, folder: 'archive' } }" 
            class="flex items-center gap-3 py-3 px-4 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-indigo-50 dark:hover:bg-gray-700/50 transition-all duration-200 group"
            active-class="bg-gradient-to-r from-indigo-100 to-purple-50 dark:from-indigo-900/30 dark:to-purple-900/30 text-indigo-700 dark:text-indigo-300 font-semibold shadow-sm"
          >
            <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
            </svg>
            <span>{{ t("sidebar.archive") }}</span>
          </router-link>
        </li>
        <li>
          <router-link
            :to="{ name: 'EmailList', params: { mailboxId: route.params.mailboxId, folder: 'spam' } }"
            class="flex items-center gap-3 py-3 px-4 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-indigo-50 dark:hover:bg-gray-700/50 transition-all duration-200 group"
            active-class="bg-gradient-to-r from-indigo-100 to-purple-50 dark:from-indigo-900/30 dark:to-purple-900/30 text-indigo-700 dark:text-indigo-300 font-semibold shadow-sm"
          >
            <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <span>{{ t("sidebar.spam") }}</span>
          </router-link>
        </li>
        <li>
          <router-link
            :to="{ name: 'EmailList', params: { mailboxId: route.params.mailboxId, folder: 'trash' } }"
            class="flex items-center gap-3 py-3 px-4 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-red-50 dark:hover:bg-gray-700/50 transition-all duration-200 group"
            active-class="bg-gradient-to-r from-red-100 to-orange-50 dark:from-red-900/30 dark:to-orange-900/30 text-red-700 dark:text-red-300 font-semibold shadow-sm"
          >
            <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 group-hover:text-red-600 dark:group-hover:text-red-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            <span>{{ t("sidebar.trash") }}</span>
          </router-link>
        </li>
        <li class="pt-6">
          <div class="flex items-center justify-between px-4 mb-3">
            <h2 class="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider">{{ t("sidebar.customFolders") }}</h2>
            <button
              @click="createNewFolder"
              class="p-1.5 text-gray-500 hover:text-indigo-600 dark:text-gray-400 dark:hover:text-indigo-400 rounded-lg hover:bg-indigo-50 dark:hover:bg-gray-700/50 transition-all duration-200"
              :title="t('sidebar.createFolderTitle')"
            >
              <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>
          <ul class="space-y-1">
            <li v-for="folder in customFolders" :key="folder.id">
              <router-link 
                :to="{ name: 'EmailList', params: { mailboxId: route.params.mailboxId, folder: folder.id } }" 
                class="flex items-center gap-3 py-3 px-4 rounded-xl text-gray-700 dark:text-gray-300 hover:bg-indigo-50 dark:hover:bg-gray-700/50 transition-all duration-200 group"
                active-class="bg-gradient-to-r from-indigo-100 to-purple-50 dark:from-indigo-900/30 dark:to-purple-900/30 text-indigo-700 dark:text-indigo-300 font-semibold shadow-sm"
              >
                <svg class="w-5 h-5 text-gray-500 dark:text-gray-400 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span class="truncate">{{ folder.name }}</span>
              </router-link>
            </li>
          </ul>
        </li>
      </ul>
    </nav>
  </aside>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useFolderStore } from "@/stores/folders";
import { useUIStore } from "@/stores/ui";

const { t } = useI18n();
const folderStore = useFolderStore();
const { folders } = storeToRefs(folderStore);
const uiStore = useUIStore();
const { isSidebarOpen } = storeToRefs(uiStore);
const route = useRoute();

// Close the mobile drawer whenever the user navigates to a folder/page.
watch(
	() => route.fullPath,
	() => uiStore.closeSidebar(),
);

const defaultFolderIds = ["archive", "inbox", "sent", "spam", "trash", "draft"];
const customFolders = computed(() => {
	return folders.value.filter(
		(folder) => !defaultFolderIds.includes(folder.name.toLowerCase()),
	);
});

onMounted(() => {
	folderStore.fetchFolders(route.params.mailboxId as string);
});

const openComposeModal = () => {
	uiStore.openComposeModal();
};

const createNewFolder = () => {
	const folderName = prompt(t("sidebar.newFolderPrompt"));
	if (folderName) {
		folderStore.createFolder(route.params.mailboxId as string, folderName);
	}
};
</script>

<template>
  <div class="flex h-screen">
    <Sidebar />
    <div class="flex-1 flex flex-col min-w-0">
      <Header />
      <main class="flex-1 overflow-y-auto p-4 min-w-0">
        <router-view />
      </main>
    </div>
    <ComposeEmail />
  </div>
</template>

<script setup lang="ts">
import { watch } from "vue";
import { useRoute } from "vue-router";
import ComposeEmail from "@/components/ComposeEmail.vue";
import Header from "@/components/Header.vue";
import Sidebar from "@/components/Sidebar.vue";
import { useMailboxStore } from "@/stores/mailboxes";

const mailboxStore = useMailboxStore();
const route = useRoute();

// Whenever the mailbox in the path changes, not only when this frame is first
// shown. A tapped notification for another mailbox is routed inside the page
// (main.ts), which reuses this frame: loaded once, the next mailbox's message
// sat inside the last one, and a reply went out as the wrong mailbox.
watch(
	() => route.params.mailboxId as string,
	(id) => {
		if (id) mailboxStore.fetchMailbox(id).catch(() => {});
	},
	{ immediate: true },
);
</script>

<template>
  <router-view />
  <!-- Pages with a row of actions of their own hold the language control in
       it; the rest get a floating one from here. Sign-in and password reset
       are the ones that matter: someone who cannot read the current language
       arrives there first, and had no way in at all. -->
  <LanguageSwitcher v-if="!route.meta.hasLanguageSwitcher" floating />
  <Toast />
</template>

<script setup lang="ts">
import { onMounted } from "vue";
import { useRoute } from "vue-router";
import LanguageSwitcher from "@/components/LanguageSwitcher.vue";
import Toast from "@/components/Toast.vue";
import { useAppSettings } from "@/composables/useAppSettings";

const route = useRoute();
const { fetchSettings } = useAppSettings();

onMounted(() => {
	fetchSettings();
});
</script>

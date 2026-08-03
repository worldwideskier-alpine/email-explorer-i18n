<template>
  <iframe
    ref="iframe"
    class="w-full h-full border-0"
    sandbox="allow-same-origin allow-popups allow-top-navigation-by-user-activation"
    :srcdoc="fullHtml"
    @load="onLoad"
  ></iframe>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";

const props = defineProps<{
	body: string;
}>();

const iframe = ref<HTMLIFrameElement | null>(null);

const fullHtml = computed(
	() => `
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          body {
            background-color: #f8f8f8;
            color: #333;
            font-family: sans-serif;
            padding: 1rem;
          }
        </style>
      </head>
      <body>
        ${props.body}
      </body>
    </html>
  `,
);

// The iframe has no allow-scripts, so links in the email body default to
// navigating the iframe itself rather than the top-level page. Force them
// to open in a new tab instead, since many login/tracking links refuse to
// render inside a frame at all (X-Frame-Options).
const onLoad = () => {
	const doc = iframe.value?.contentDocument;
	if (!doc) return;
	doc.addEventListener("click", (event) => {
		const anchor = (event.target as HTMLElement | null)?.closest?.("a");
		if (anchor?.href) {
			event.preventDefault();
			window.open(anchor.href, "_blank", "noopener,noreferrer");
		}
	});
};
</script>

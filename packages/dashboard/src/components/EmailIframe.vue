<template>
  <iframe
    class="w-full h-full border-0"
    sandbox="allow-same-origin allow-popups allow-top-navigation-by-user-activation"
    :srcdoc="fullHtml"
  ></iframe>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
	body: string;
}>();

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
</script>

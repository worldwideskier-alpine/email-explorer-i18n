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
          a {
            color: #2563eb;
            text-decoration: underline;
          }
        </style>
      </head>
      <body>
        ${props.body}
      </body>
    </html>
  `,
);

const URL_PATTERN = String.raw`https?:\/\/[^\s<>"']+`;
// Trailing characters that are almost never actually part of the URL --
// closing punctuation the sender's prose put right after it (Japanese and
// ASCII), or a bare trailing slash-less sentence terminator.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}、。）」』】]+$/;

/**
 * Plain-text emails are stored as an escaped `<pre>` block (see
 * plain-text-to-html.ts) with bare URLs as plain text, and even genuine
 * HTML emails sometimes include a bare URL outside any `<a>`. Walk text
 * nodes (skipping ones already inside a link, script, or style) and wrap
 * URL-looking substrings in real `<a>` elements so they're clickable.
 */
function linkifyPlainUrls(doc: Document) {
	if (!doc.body) return;

	const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
		acceptNode(node) {
			const parent = (node as Text).parentElement;
			if (!parent || parent.closest("a, script, style")) {
				return NodeFilter.FILTER_REJECT;
			}
			return new RegExp(URL_PATTERN).test(node.textContent || "")
				? NodeFilter.FILTER_ACCEPT
				: NodeFilter.FILTER_REJECT;
		},
	});

	const textNodes: Text[] = [];
	let current = walker.nextNode();
	while (current) {
		textNodes.push(current as Text);
		current = walker.nextNode();
	}

	for (const textNode of textNodes) {
		const text = textNode.textContent || "";
		const frag = doc.createDocumentFragment();
		let lastIndex = 0;

		for (const match of text.matchAll(new RegExp(URL_PATTERN, "g"))) {
			let url = match[0];
			const trailing = url.match(TRAILING_PUNCTUATION)?.[0] || "";
			url = url.slice(0, url.length - trailing.length);
			if (!url) continue;

			const start = match.index as number;
			frag.appendChild(doc.createTextNode(text.slice(lastIndex, start)));
			const a = doc.createElement("a");
			a.href = url;
			a.textContent = url;
			a.target = "_blank";
			a.rel = "noopener noreferrer";
			frag.appendChild(a);
			lastIndex = start + url.length;
		}

		if (lastIndex === 0) continue;
		frag.appendChild(doc.createTextNode(text.slice(lastIndex)));
		textNode.replaceWith(frag);
	}
}

// The iframe has no allow-scripts, so links in the email body default to
// navigating the iframe itself rather than the top-level page. Force them
// to open in a new tab instead, since many login/tracking links refuse to
// render inside a frame at all (X-Frame-Options).
const onLoad = () => {
	const doc = iframe.value?.contentDocument;
	if (!doc) return;

	linkifyPlainUrls(doc);

	doc.addEventListener("click", (event) => {
		const anchor = (event.target as HTMLElement | null)?.closest?.("a");
		if (anchor?.href) {
			event.preventDefault();
			window.open(anchor.href, "_blank", "noopener,noreferrer");
		}
	});
};
</script>

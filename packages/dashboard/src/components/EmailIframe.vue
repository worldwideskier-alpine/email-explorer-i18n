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
import { stripRemoteContent } from "@/utils/remoteContent";

const props = defineProps<{
	body: string;
	// When true (spam-folder emails), links are never made clickable --
	// bare URLs are left as plain text and any real <a> tags from the
	// sender have their href stripped, since a spam/phishing message is
	// exactly the content where an accidental click is most dangerous.
	disableLinks?: boolean;
	// When true (spam-folder emails again), nothing in the body may fetch
	// anything: no images, no stylesheets, no media. A tracking pixel reports
	// the open, and for a spam run that is the point of having sent it --
	// looking at a message to decide whether it is spam should not be what
	// confirms the address is live.
	blockRemoteContent?: boolean;
}>();

const iframe = ref<HTMLIFrameElement | null>(null);

/**
 * The body as the frame will receive it.
 *
 * This has to happen here, on the string, and not in the load handler below:
 * by the time a frame has loaded, everything in it has already been fetched.
 * Removing an image then would remove only the picture, not the request.
 */
const renderedBody = computed(() =>
	props.blockRemoteContent ? stripRemoteContent(props.body) : props.body,
);

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
        ${renderedBody.value}
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

/**
 * Strips every real `<a>` tag's href (and target) so it can't navigate
 * anywhere by any means -- left-click, middle-click, or "open in new tab"
 * from the context menu, none of which a JS click handler alone can stop.
 * The link text stays visible, just inert and visually de-emphasized.
 */
function neutralizeLinks(doc: Document) {
	if (!doc.body) return;
	for (const anchor of doc.body.querySelectorAll("a")) {
		anchor.removeAttribute("href");
		anchor.removeAttribute("target");
		anchor.style.color = "inherit";
		anchor.style.textDecoration = "none";
		anchor.style.cursor = "text";
		anchor.title = "";
	}
}

// The iframe has no allow-scripts, so links in the email body default to
// navigating the iframe itself rather than the top-level page. Force them
// to open in a new tab instead, since many login/tracking links refuse to
// render inside a frame at all (X-Frame-Options).
const onLoad = () => {
	const doc = iframe.value?.contentDocument;
	if (!doc) return;

	if (props.disableLinks) {
		neutralizeLinks(doc);
		return;
	}

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

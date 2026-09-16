<template>
  <iframe
    ref="iframe"
    class="w-full h-full border-0"
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    :srcdoc="fullHtml"
    @load="onLoad"
  ></iframe>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import {
	linkifyPlainUrls,
	neutralizeLinks,
	sendLinksToANewTab,
} from "@/utils/emailLinks";
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

/**
 * Why this frame may open tabs but may not do anything else.
 *
 * `allow-popups` is what lets a link in a message open one at all; without it
 * a link with nowhere else to go navigates the frame, and the message is
 * replaced by a browser error page. Two separate things produce that page and
 * the first one is ours: this application's own `Content-Security-Policy` says
 * `frame-src 'self' blob:`, and a `srcdoc` frame inherits it, so Chromium
 * refuses the navigation outright ("Refused to frame ... because it violates
 * ... frame-src") whatever the destination is. `X-Frame-Options` from the
 * destination does the same thing a moment later. Measured both ways against
 * the real policy; the CSP is what makes it every link rather than most.
 *
 * `allow-popups-to-escape-sandbox` is what makes the tab it opens a *normal*
 * one. Measured in Chromium: without the flag the opened page inherits this
 * frame's sandbox, so it loads with no scripts and an opaque origin -- the
 * probe page reported "scripts did NOT run" -- and most sites are simply
 * broken in that state. With it, the same page reported its own origin.
 *
 * `allow-top-navigation-by-user-activation` used to be here and is gone. It
 * let a message replace this whole application with a page of the sender's
 * choosing, which is the shape of a phishing page, and now that every link
 * that leaves is given `target="_blank"` (see utils/emailLinks.ts) nothing
 * asks for it. Scripts are still not allowed, and neither are forms.
 */
const onLoad = () => {
	const doc = iframe.value?.contentDocument;
	if (!doc) return;

	if (props.disableLinks) {
		neutralizeLinks(doc);
		return;
	}

	// Order matters, and so does the guard. The sweep is what stands between a
	// link and the message disappearing, and it used to run only if the pass
	// before it returned -- so any fault in linkifying, on any engine, took
	// the protection with it silently. Linkifying is a convenience; this is
	// not, so it runs either way.
	try {
		linkifyPlainUrls(doc);
	} catch (error) {
		console.error(`could not linkify the bare URLs in a message: ${error}`);
	}
	sendLinksToANewTab(doc);
};
</script>

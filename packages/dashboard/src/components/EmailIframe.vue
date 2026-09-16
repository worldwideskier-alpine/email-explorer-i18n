<template>
  <iframe
    class="w-full h-full border-0"
    sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    :srcdoc="fullHtml"
  ></iframe>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { prepareLinks } from "@/utils/emailLinks";
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

/**
 * The body as the frame will receive it: everything decided here, on the
 * string, and nothing left for afterwards.
 *
 * Remote content has to be taken out before the parser sees it, because by
 * the time a frame has loaded, everything in it has already been fetched --
 * removing an image then removes the picture and not the request.
 *
 * Links are here for the same kind of reason, learned the hard way. They were
 * rewritten in a `load` handler, and a frame does not fire `load` until every
 * image in it has arrived: measured at three seconds into a message with one
 * slow picture, the text was on screen and tappable and the links had not
 * been touched yet. Tapping one then navigated the frame, the page's own
 * `frame-src 'self'` refused it, and the message was replaced by a grey
 * "This content is blocked". A message is tappable from the first paint, so
 * anything that decides what a tap does has to be true from the first paint.
 *
 * There is no load handler left at all now, and no template ref to reach the
 * frame's document with. See utils/emailLinks.ts.
 */
const renderedBody = computed(() => {
	const body = props.blockRemoteContent
		? stripRemoteContent(props.body)
		: props.body;
	return prepareLinks(body, { disable: props.disableLinks });
});

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
 * Why this frame may open tabs and may do nothing else.
 *
 * `allow-popups` is what lets a link open one at all. Without it a sandboxed
 * frame does not merely fail to open a tab -- `target="_blank"` is forced
 * back into the frame itself, which is the fault above with extra steps.
 *
 * `allow-popups-to-escape-sandbox` is what makes the tab it opens a normal
 * one. Measured: without the flag the opened page inherits this frame's
 * sandbox and loads with no scripts and an opaque origin (the probe page
 * reported "scripts did NOT run"); with it, the same page reported its own
 * origin.
 *
 * `allow-top-navigation-by-user-activation` used to be here and is gone: it
 * let a message replace this whole application with a page of the sender's
 * choosing, and nothing asks for it now that every outbound link is given
 * `target="_blank"`. Scripts are not allowed, and neither are forms.
 */
</script>

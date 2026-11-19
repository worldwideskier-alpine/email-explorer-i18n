<template>
  <div class="rich-text-editor border border-gray-300 dark:border-gray-600 rounded-xl overflow-hidden bg-gray-50 dark:bg-gray-900/50">
    <!-- Toolbar -->
    <div v-if="editor" class="toolbar bg-white dark:bg-gray-800 border-b border-gray-300 dark:border-gray-600 p-2 flex flex-wrap gap-1 flex-shrink-0">
      <!-- Text Formatting -->
      <div class="flex gap-1 border-e border-gray-300 dark:border-gray-600 pe-2">
        <button
          type="button"
          @click="editor.chain().focus().toggleBold().run()"
          :class="{ 'is-active': editor.isActive('bold') }"
          class="toolbar-btn"
          :title="t('richTextEditor.bold')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6z" />
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M6 12h9a4 4 0 014 4 4 4 0 01-4 4H6z" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().toggleItalic().run()"
          :class="{ 'is-active': editor.isActive('italic') }"
          class="toolbar-btn"
          :title="t('richTextEditor.italic')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 4h4m-4 16h4m-2-16l-2 16" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().toggleUnderline().run()"
          :class="{ 'is-active': editor.isActive('underline') }"
          class="toolbar-btn"
          :title="t('richTextEditor.underline')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 20h10M7 4v7a5 5 0 0010 0V4" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().toggleStrike().run()"
          :class="{ 'is-active': editor.isActive('strike') }"
          class="toolbar-btn"
          :title="t('richTextEditor.strikethrough')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12h18M8 5h8M9 19h6" />
          </svg>
        </button>
      </div>

      <!-- Headings -->
      <div class="flex gap-1 border-e border-gray-300 dark:border-gray-600 pe-2">
        <button
          type="button"
          @click="editor.chain().focus().toggleHeading({ level: 1 }).run()"
          :class="{ 'is-active': editor.isActive('heading', { level: 1 }) }"
          class="toolbar-btn text-xs font-bold"
          :title="t('richTextEditor.heading1')"
        >
          H1
        </button>
        <button
          type="button"
          @click="editor.chain().focus().toggleHeading({ level: 2 }).run()"
          :class="{ 'is-active': editor.isActive('heading', { level: 2 }) }"
          class="toolbar-btn text-xs font-bold"
          :title="t('richTextEditor.heading2')"
        >
          H2
        </button>
        <button
          type="button"
          @click="editor.chain().focus().toggleHeading({ level: 3 }).run()"
          :class="{ 'is-active': editor.isActive('heading', { level: 3 }) }"
          class="toolbar-btn text-xs font-bold"
          :title="t('richTextEditor.heading3')"
        >
          H3
        </button>
      </div>

      <!-- Lists -->
      <div class="flex gap-1 border-e border-gray-300 dark:border-gray-600 pe-2">
        <button
          type="button"
          @click="editor.chain().focus().toggleBulletList().run()"
          :class="{ 'is-active': editor.isActive('bulletList') }"
          class="toolbar-btn"
          :title="t('richTextEditor.bulletList')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().toggleOrderedList().run()"
          :class="{ 'is-active': editor.isActive('orderedList') }"
          class="toolbar-btn"
          :title="t('richTextEditor.numberedList')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h10M7 12h10M7 17h10M3 7v10" />
          </svg>
        </button>
      </div>

      <!-- Text Alignment -->
      <div class="flex gap-1 border-e border-gray-300 dark:border-gray-600 pe-2">
        <button
          type="button"
          @click="editor.chain().focus().setTextAlign('left').run()"
          :class="{ 'is-active': editor.isActive({ textAlign: 'left' }) }"
          class="toolbar-btn"
          :title="t('richTextEditor.alignLeft')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h10M4 18h16" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().setTextAlign('center').run()"
          :class="{ 'is-active': editor.isActive({ textAlign: 'center' }) }"
          class="toolbar-btn"
          :title="t('richTextEditor.alignCenter')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M7 12h10M4 18h16" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().setTextAlign('right').run()"
          :class="{ 'is-active': editor.isActive({ textAlign: 'right' }) }"
          class="toolbar-btn"
          :title="t('richTextEditor.alignRight')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M10 12h10M4 18h16" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().setTextAlign('justify').run()"
          :class="{ 'is-active': editor.isActive({ textAlign: 'justify' }) }"
          class="toolbar-btn"
          :title="t('richTextEditor.justify')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      <!-- Blockquote & Code -->
      <div class="flex gap-1 border-e border-gray-300 dark:border-gray-600 pe-2">
        <button
          type="button"
          @click="editor.chain().focus().toggleBlockquote().run()"
          :class="{ 'is-active': editor.isActive('blockquote') }"
          class="toolbar-btn"
          :title="t('richTextEditor.blockquote')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().toggleCode().run()"
          :class="{ 'is-active': editor.isActive('code') }"
          class="toolbar-btn"
          :title="t('richTextEditor.inlineCode')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().toggleCodeBlock().run()"
          :class="{ 'is-active': editor.isActive('codeBlock') }"
          class="toolbar-btn"
          :title="t('richTextEditor.codeBlock')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </button>
      </div>

      <!-- Link & Horizontal Rule -->
      <div class="flex gap-1 border-e border-gray-300 dark:border-gray-600 pe-2">
        <button
          type="button"
          @click="setLink"
          :class="{ 'is-active': editor.isActive('link') }"
          class="toolbar-btn"
          :title="t('richTextEditor.insertLink')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
          </svg>
        </button>
        <button
          type="button"
          v-if="editor.isActive('link')"
          @click="editor.chain().focus().unsetLink().run()"
          class="toolbar-btn"
          :title="t('richTextEditor.removeLink')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().setHorizontalRule().run()"
          class="toolbar-btn"
          :title="t('richTextEditor.horizontalRule')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 12h14" />
          </svg>
        </button>
      </div>

      <!-- Text Color & Highlight -->
      <div class="flex gap-1 border-e border-gray-300 dark:border-gray-600 pe-2">
        <button
          ref="textColourToggle"
          type="button"
          @click="togglePicker('text', $event)"
          class="toolbar-btn"
          :title="t('richTextEditor.textColor')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
          </svg>
        </button>
        <button
          ref="highlightToggle"
          type="button"
          @click="togglePicker('highlight', $event)"
          class="toolbar-btn"
          :title="t('richTextEditor.highlight')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 20l4-16m2 16l4-16M6 9h14M4 15h14" />
          </svg>
        </button>
      </div>

      <!-- Utilities -->
      <div class="flex gap-1">
        <button
          type="button"
          @click="editor.chain().focus().undo().run()"
          :disabled="!editor.can().undo()"
          class="toolbar-btn"
          :title="t('richTextEditor.undo')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
          </svg>
        </button>
        <button
          type="button"
          @click="editor.chain().focus().redo().run()"
          :disabled="!editor.can().redo()"
          class="toolbar-btn"
          :title="t('richTextEditor.redo')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 10h-10a8 8 0 00-8 8v2m18-10l-6 6m6-6l-6-6" />
          </svg>
        </button>
        <button
          type="button"
          @click="showSourceCode = !showSourceCode"
          class="toolbar-btn"
          :class="{ 'is-active': showSourceCode }"
          :title="t('richTextEditor.toggleSourceCode')"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Editor Content or Source Code -->
    <!-- 300px as a starting size, not a floor: where nothing holds the editor
         to a height (the signature on Settings) the box is 300px, and where
         something does (the compose dialog) it shrinks to fit. As a floor it
         passed the editor's edge there, and the editor's overflow-hidden cut
         off the bottom 59-508px of what was being typed. -->
    <div v-if="showSourceCode" class="p-4 flex-1 flex flex-col min-h-0">
      <textarea
        v-model="sourceCode"
        @input="updateFromSource"
        class="w-full grow basis-[300px] min-h-0 resize-none bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 border border-gray-300 dark:border-gray-600 rounded-lg p-3 font-mono text-sm"
        :placeholder="t('richTextEditor.sourceCodePlaceholder')"
      />
    </div>
    <editor-content v-else :editor="editor" class="max-w-none p-4 text-gray-900 dark:text-gray-100 flex-1 min-h-0 overflow-y-auto" />

    <!-- The colour swatches are drawn over the whole page, not under their
         button. Hung below the button (absolute, inside a 32px-wide
         wrapper), the grid's five columns shared those 32px and the swatches
         lay over one another -- 3 of 15 text colours and 2 of 10 highlights
         could be pressed -- and the editor's overflow-hidden, and the compose
         dialog's, cut off what hung past them: 0 of 15 at 375px. Fixed,
         w-max so the grid is as wide as its swatches, placed from the button
         (popupPlacement.ts) and above the compose dialog (z-50). Out of the
         page's flow it no longer follows its button, scrolls out of sight with
         it or comes next in the Tab order, so the script gives each back. -->
    <Teleport to="body">
      <div
        v-if="openPicker"
        ref="pickerPanel"
        data-colour-swatches
        class="fixed z-[60] w-max grid grid-cols-5 gap-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg p-2 shadow-lg"
        :style="pickerPlace"
        @keydown="leaveSwatchesByTab"
      >
        <button
          v-for="color in openPicker === 'text' ? textColors : highlightColors"
          :key="color"
          type="button"
          @click="openPicker === 'text' ? setTextColor(color) : setHighlight(color)"
          class="w-6 h-6 rounded border border-gray-300 dark:border-gray-600"
          :style="{ backgroundColor: color }"
          :title="color"
        />
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import Image from "@tiptap/extension-image";
import { TableKit } from "@tiptap/extension-table";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, generateJSON, useEditor } from "@tiptap/vue-3";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ColourHighlight, TextColour } from "@/utils/editorColours";
import { QuotedLink } from "@/utils/editorLinks";
import {
	BoundedTableCell,
	BoundedTableHeader,
	boundPasted,
	boundTables,
	TableBudget,
} from "@/utils/editorTables";
import { buttonInSight, placeFromButton } from "@/utils/popupPlacement";

const props = defineProps<{
	modelValue: string;
}>();

const emit = defineEmits<{
	"update:modelValue": [value: string];
}>();

const { t } = useI18n();

const showSourceCode = ref(false);
const sourceCode = ref("");
const openPicker = ref<"text" | "highlight" | null>(null);
const textColourToggle = ref<HTMLButtonElement | null>(null);
const highlightToggle = ref<HTMLButtonElement | null>(null);
const pickerPanel = ref<HTMLElement | null>(null);
/** Hidden until it is measured and placed, so it never shows where it is not. */
const pickerPlace = ref<Record<string, string>>({ visibility: "hidden" });

const textColors = [
	"#000000",
	"#333333",
	"#666666",
	"#999999",
	"#CCCCCC",
	"#FF0000",
	"#FF6B6B",
	"#FFA500",
	"#FFD700",
	"#FFFF00",
	"#00FF00",
	"#00CED1",
	"#0000FF",
	"#9370DB",
	"#FF1493",
];

const highlightColors = [
	"#FFFF00",
	"#FFE4B5",
	"#FFB6C1",
	"#ADD8E6",
	"#90EE90",
	"#DDA0DD",
	"#F0E68C",
	"#FFDAB9",
	"#E0BBE4",
	"#C1E1C1",
];

const extensions = [
	// StarterKit 3 carries its own Link and Underline. Left in, they ran
	// beside the ones configured below -- two `link` extensions, and the
	// kit's has openOnClick on, so clicking a link in a message being
	// written opened it in a new tab.
	StarterKit.configure({ link: false, underline: false }),
	Underline,
	TextAlign.configure({
		types: ["heading", "paragraph"],
	}),
	// The sender's class stays out of this page (see editorLinks).
	QuotedLink.configure({
		openOnClick: false,
		HTMLAttributes: {
			class: "text-blue-600 underline hover:text-blue-800",
		},
	}),
	Image,
	TextStyle,
	// Only a colour, from a message being replied to: see editorColours.
	TextColour,
	ColourHighlight,
	// Without this, a table in the message being replied to is dropped and
	// the reply carries its cells as loose text -- an invoice or a quote
	// comes back to the sender unreadable.
	//
	// The borders are inline styles rather than a stylesheet because the
	// result is sent as an email, and mail clients strip <style>. Column
	// resizing is off: it is a composing convenience that costs handle
	// markup in the message, and what matters here is quoting a table back
	// intact.
	TableKit.configure({
		table: {
			resizable: false,
			HTMLAttributes: {
				style: "border-collapse: collapse; margin: 8px 0;",
			},
		},
		// The kit's own cells read a span as written; these hold it to what
		// a browser would (see editorTables).
		tableCell: false,
		tableHeader: false,
	}),
	BoundedTableCell.configure({
		HTMLAttributes: {
			style: "border: 1px solid #ccc; padding: 4px 8px;",
		},
	}),
	BoundedTableHeader.configure({
		HTMLAttributes: {
			style:
				"border: 1px solid #ccc; padding: 4px 8px; background: #f3f4f6; font-weight: 600;",
		},
	}),
	TableBudget,
];

/**
 * What goes into the editor: the HTML as the editor parses it, with any
 * table too large to lay out quoted as its contents instead (editorTables).
 * Every way content arrives goes through this -- the message being replied
 * to, a draft, the source box.
 */
const bounded = (html: string) => boundTables(generateJSON(html, extensions));

const editor = useEditor({
	extensions,
	content: bounded(props.modelValue),
	editorProps: {
		attributes: {
			class: "max-w-none focus:outline-none min-h-full",
		},
		// Pasting and dropping are ways in too (see editorTables).
		transformPasted: (slice, view) => boundPasted(slice, view.state),
	},
	// The editor's HTML does not go back into the source box while it is open.
	// In source mode the box is what is being typed into, and each keystroke
	// reaches the editor (updateFromSource) and came straight back out of it
	// normalised: a lone `<` became `<p>&lt;</p>`, the caret jumped to the
	// end, and a tag edited a letter at a time lost its formatting at the
	// first half-typed step. The box is read from the editor when it opens.
	onUpdate: ({ editor }) => {
		emit("update:modelValue", editor.getHTML());
	},
});

// Watch for external changes to modelValue
watch(
	() => props.modelValue,
	(newValue) => {
		if (editor.value && newValue !== editor.value.getHTML()) {
			editor.value.commands.setContent(bounded(newValue));
		}
	},
);

// Update editor from source code
const updateFromSource = () => {
	if (editor.value) {
		editor.value.commands.setContent(bounded(sourceCode.value));
	}
};

// Toggle source code view
watch(showSourceCode, (isShown) => {
	if (isShown) {
		sourceCode.value = editor.value?.getHTML() || "";
	}
});

// Link functionality
const setLink = () => {
	const previousUrl = editor.value?.getAttributes("link").href;
	const url = window.prompt(t("richTextEditor.urlPrompt"), previousUrl);

	if (url === null) {
		return;
	}

	if (url === "") {
		editor.value?.chain().focus().extendMarkRange("link").unsetLink().run();
		return;
	}

	editor.value
		?.chain()
		.focus()
		.extendMarkRange("link")
		.setLink({ href: url })
		.run();
};

// Text color functionality
const setTextColor = (color: string) => {
	editor.value?.chain().focus().setColor(color).run();
	openPicker.value = null;
};

// Highlight functionality
const setHighlight = (color: string) => {
	editor.value?.chain().focus().toggleHighlight({ color }).run();
	openPicker.value = null;
};

async function togglePicker(which: "text" | "highlight", event?: MouseEvent) {
	if (openPicker.value === which) {
		openPicker.value = null;
		return;
	}
	pickerPlace.value = { visibility: "hidden" };
	openPicker.value = which;
	await nextTick();
	if (openPicker.value !== which) return;
	placePicker();
	// Opened from the keyboard (a click no pointer made): the swatches are at
	// the end of <body>, past the rest of the dialog or page -- measured, ten
	// Tab presses on in compose and fifteen on Settings -- where they used to
	// be the next stop after the button.
	if (event?.detail !== 0) return;
	// Once they are drawn placed: until then they are still visibility:
	// hidden, whose buttons take no focus (measured in Chromium, where it
	// stayed on the button; jsdom gives it anyway).
	await nextTick();
	if (openPicker.value !== which) return;
	pickerPanel.value
		?.querySelector<HTMLElement>("button")
		?.focus({ preventScroll: true });
}

const openToggle = () =>
	openPicker.value === "text"
		? textColourToggle.value
		: openPicker.value === "highlight"
			? highlightToggle.value
			: null;

/** Boxes around an element that cut off what overflows them. */
function clipsAround(element: Element): DOMRect[] {
	const clips: DOMRect[] = [];
	for (let box = element.parentElement; box; box = box.parentElement) {
		const { overflowX, overflowY } = getComputedStyle(box);
		if (overflowX !== "visible" || overflowY !== "visible") {
			clips.push(box.getBoundingClientRect());
		}
	}
	return clips;
}

function placePicker() {
	const button = openToggle();
	const panel = pickerPanel.value;
	if (!button || !panel) return;
	const viewport = { width: window.innerWidth, height: window.innerHeight };
	const at = button.getBoundingClientRect();
	if (!buttonInSight(at, clipsAround(button), viewport)) {
		// Hidden, not closed: it comes back with its button, as it did when it
		// hung from it.
		pickerPlace.value = { ...pickerPlace.value, visibility: "hidden" };
		return;
	}
	const size = panel.getBoundingClientRect();
	const { top, left } = placeFromButton(
		at,
		{ width: size.width, height: size.height },
		viewport,
		getComputedStyle(button).direction === "rtl",
	);
	pickerPlace.value = { top: `${top}px`, left: `${left}px` };
}

const closePicker = () => {
	openPicker.value = null;
};

/** Close the swatches and give the keyboard back to the button they came from. */
function backToToggle() {
	const toggle = openToggle();
	closePicker();
	toggle?.focus();
}

// Tab past the last swatch, or Shift+Tab before the first, goes back to the
// button: past the end of <body> there is nothing of the page left to reach.
function leaveSwatchesByTab(event: KeyboardEvent) {
	if (event.key !== "Tab") return;
	const swatches = pickerPanel.value?.querySelectorAll("button");
	if (!swatches?.length) return;
	const edge = event.shiftKey ? swatches[0] : swatches[swatches.length - 1];
	if (event.target !== edge) return;
	event.preventDefault();
	backToToggle();
}

// A click anywhere but this editor's swatches and their two buttons closes
// them. Asked of this editor's own elements: `.closest(".relative")` also
// counted every other element on the page with that class, and a marker
// shared by every editor would leave another editor's swatches open.
const handleClickOutside = (event: MouseEvent) => {
	if (!openPicker.value) return;
	const target = event.target as Node | null;
	const own = [
		pickerPanel.value,
		textColourToggle.value,
		highlightToggle.value,
	];
	if (target && own.some((element) => element?.contains(target))) return;
	closePicker();
};

const closeOnEscape = (event: KeyboardEvent) => {
	if (event.key !== "Escape") return;
	// Focus inside the swatches would be dropped on <body> with them.
	if (pickerPanel.value?.contains(document.activeElement)) backToToggle();
	else closePicker();
};

// While they are open. A scroll anywhere (capture: the compose dialog, the
// editor and Settings' main column scroll, not the window), a resize, or the
// end of a transition moves the button -- the compose dialog animates its
// height for 150ms after a resize -- so the swatches are placed again from
// where it now is. Not closed: a phone's keyboard going away is a resize.
const whileOpen = [
	["keydown", closeOnEscape, false],
	["scroll", placePicker, true],
	["resize", placePicker, false],
	["transitionend", placePicker, true],
] as const;

const listenWhileOpen = (listen: boolean) => {
	for (const [type, handler, capture] of whileOpen) {
		if (listen)
			window.addEventListener(type, handler as EventListener, capture);
		else window.removeEventListener(type, handler as EventListener, capture);
	}
};

watch(openPicker, (open, wasOpen) => {
	if (typeof window === "undefined") return;
	if (open && !wasOpen) listenWhileOpen(true);
	else if (!open && wasOpen) listenWhileOpen(false);
});

if (typeof window !== "undefined") {
	window.addEventListener("click", handleClickOutside);
}

onBeforeUnmount(() => {
	editor.value?.destroy();
	if (typeof window !== "undefined") {
		window.removeEventListener("click", handleClickOutside);
		listenWhileOpen(false);
	}
});
</script>

<style scoped>
.toolbar-btn {
  padding: 0.5rem;
  border-radius: 0.5rem;
  color: rgb(55 65 81);
  transition: all 150ms;
}

.toolbar-btn:hover {
  background-color: rgb(243 244 246);
}

.toolbar-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toolbar-btn.is-active {
  background-color: rgb(224 231 255);
  color: rgb(79 70 229);
}

@media (prefers-color-scheme: dark) {
  .toolbar-btn {
    color: rgb(209 213 219);
  }
  
  .toolbar-btn:hover {
    background-color: rgb(55 65 81);
  }
  
  .toolbar-btn.is-active {
    background-color: rgb(49 46 129);
    color: rgb(165 180 252);
  }
}

/* TipTap Editor Styles */
:deep(.ProseMirror) {
  outline: none;
  min-height: 100%;
  color: rgb(17 24 39);
}

:deep(.ProseMirror p) {
  margin-bottom: 0.75rem;
}

:deep(.ProseMirror h1) {
  font-size: 1.875rem;
  font-weight: bold;
  margin-bottom: 1rem;
}

:deep(.ProseMirror h2) {
  font-size: 1.5rem;
  font-weight: bold;
  margin-bottom: 0.75rem;
}

:deep(.ProseMirror h3) {
  font-size: 1.25rem;
  font-weight: bold;
  margin-bottom: 0.5rem;
}

:deep(.ProseMirror ul),
:deep(.ProseMirror ol) {
  padding-left: 1.5rem;
  margin-bottom: 0.75rem;
}

:deep(.ProseMirror ul) {
  list-style-type: disc;
}

:deep(.ProseMirror ol) {
  list-style-type: decimal;
}

:deep(.ProseMirror blockquote) {
  border-left: 4px solid rgb(209 213 219);
  padding-left: 1rem;
  font-style: italic;
  margin: 1rem 0;
}

:deep(.ProseMirror code) {
  background-color: rgb(229 231 235);
  padding: 0.125rem 0.25rem;
  border-radius: 0.25rem;
  font-size: 0.875rem;
  font-family: monospace;
}

:deep(.ProseMirror pre) {
  background-color: rgb(229 231 235);
  padding: 1rem;
  border-radius: 0.5rem;
  overflow-x: auto;
  margin: 1rem 0;
}

:deep(.ProseMirror pre code) {
  background-color: transparent;
  padding: 0;
}

:deep(.ProseMirror a) {
  color: rgb(37 99 235);
  text-decoration: underline;
}

:deep(.ProseMirror a:hover) {
  color: rgb(29 78 216);
}

:deep(.ProseMirror img) {
  max-width: 100%;
  height: auto;
  border-radius: 0.5rem;
}

:deep(.ProseMirror hr) {
  margin: 1rem 0;
  border-color: rgb(209 213 219);
}

@media (prefers-color-scheme: dark) {
  :deep(.ProseMirror) {
    color: rgb(243 244 246);
  }
  
  :deep(.ProseMirror blockquote) {
    border-left-color: rgb(75 85 99);
  }
  
  :deep(.ProseMirror code) {
    background-color: rgb(55 65 81);
  }
  
  :deep(.ProseMirror pre) {
    background-color: rgb(55 65 81);
  }
  
  :deep(.ProseMirror a) {
    color: rgb(96 165 250);
  }
  
  :deep(.ProseMirror a:hover) {
    color: rgb(147 197 253);
  }
  
  :deep(.ProseMirror hr) {
    border-color: rgb(75 85 99);
  }
}
</style>

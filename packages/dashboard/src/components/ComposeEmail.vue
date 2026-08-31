<template>
  <div v-if="isComposeModalOpen" class="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center z-50 p-4">
    <div class="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-full max-w-3xl h-[85vh] text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 overflow-hidden transform transition-all flex flex-col">
      <div class="flex justify-between items-center bg-gradient-to-r from-indigo-600 to-purple-600 px-6 py-5 flex-shrink-0">
        <div class="flex items-center gap-3">
          <div class="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
            <svg class="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </div>
          <h2 class="text-xl font-bold text-white">{{ modalTitle }}</h2>
        </div>
        <button @click="closeModal" class="text-white/80 hover:text-white hover:bg-white/10 rounded-lg p-2 transition-all duration-200">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <form @submit.prevent="send" class="flex flex-col flex-1 min-h-0">
        <div class="p-6 overflow-y-auto flex-1 min-h-0 flex flex-col">
          <div v-if="error" class="bg-red-50 border-l-4 border-red-500 text-red-800 px-4 py-3 rounded-lg mb-6 flex items-start gap-3 flex-shrink-0" role="alert">
            <svg class="w-5 h-5 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd" />
            </svg>
            <span class="block sm:inline">{{ error }}</span>
          </div>
          <div class="mb-5 flex-shrink-0">
            <div class="flex items-baseline justify-between mb-2">
              <label for="to" class="block text-sm font-semibold text-gray-700 dark:text-gray-300">{{ t("compose.to") }}</label>
              <button
                v-if="!showCcBcc"
                type="button"
                @click="showCcBcc = true"
                class="text-sm font-medium text-indigo-600 dark:text-indigo-400 hover:underline"
              >{{ t("compose.addCcBcc") }}</button>
            </div>
            <!-- The placeholder stays a literal: vue-i18n reads "@" in a
                 message as the start of a linked key, so an example address
                 in the catalogue fails to compile and takes the whole dialog
                 with it. An address example needs no translating anyway. -->
            <input
              type="email"
              id="to"
              multiple
              v-model="to"
              class="block w-full bg-gray-50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-xl shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent dark:focus:ring-indigo-400 text-gray-900 dark:text-gray-100 px-4 py-3 transition-all duration-200"
              placeholder="recipient@example.com, another@example.com"
              required
            />
            <p class="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{{ t("compose.recipientsHint") }}</p>
          </div>
          <div v-if="showCcBcc" class="mb-5 flex-shrink-0">
            <label for="cc" class="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">{{ t("compose.cc") }}</label>
            <input
              type="email"
              id="cc"
              multiple
              v-model="cc"
              class="block w-full bg-gray-50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-xl shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent dark:focus:ring-indigo-400 text-gray-900 dark:text-gray-100 px-4 py-3 transition-all duration-200"
              placeholder="recipient@example.com, another@example.com"
            />
          </div>
          <div v-if="showCcBcc" class="mb-5 flex-shrink-0">
            <label for="bcc" class="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">{{ t("compose.bcc") }}</label>
            <input
              type="email"
              id="bcc"
              multiple
              v-model="bcc"
              class="block w-full bg-gray-50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-xl shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent dark:focus:ring-indigo-400 text-gray-900 dark:text-gray-100 px-4 py-3 transition-all duration-200"
              placeholder="recipient@example.com, another@example.com"
            />
            <p class="mt-1.5 text-xs text-gray-500 dark:text-gray-400">{{ t("compose.bccHint") }}</p>
          </div>
          <div class="mb-5 flex-shrink-0">
            <label for="subject" class="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">{{ t("compose.subject") }}</label>
            <input
              type="text"
              id="subject"
              v-model="subject"
              class="block w-full bg-gray-50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-xl shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent dark:focus:ring-indigo-400 text-gray-900 dark:text-gray-100 px-4 py-3 transition-all duration-200"
              :placeholder="t('compose.subjectPlaceholder')"
              required
            />
          </div>
          <div class="flex-1 flex flex-col min-h-0">
            <div class="flex items-center justify-between mb-2 flex-shrink-0">
              <label for="body" class="block text-sm font-semibold text-gray-700 dark:text-gray-300">{{ t("compose.message") }}</label>
              <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 cursor-pointer select-none">
                <input type="checkbox" v-model="isPlainText" class="rounded border-gray-300 dark:border-gray-600 text-indigo-600 focus:ring-indigo-500" />
                {{ t("compose.plainTextMode") }}
              </label>
            </div>
            <RichTextEditor v-if="!isPlainText" v-model="body" class="flex-1 flex flex-col min-h-0" />
            <textarea
              v-else
              v-model="plainBody"
              class="flex-1 min-h-[300px] resize-none block w-full bg-gray-50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-xl shadow-sm focus:ring-2 focus:ring-indigo-500 focus:border-transparent dark:focus:ring-indigo-400 text-gray-900 dark:text-gray-100 px-4 py-3 font-mono text-sm transition-all duration-200"
            ></textarea>
          </div>

          <!-- Attachments. The list is below the body rather than beside the
               address fields because it grows, and pushing the message down
               as files are added is less disruptive than reflowing the head
               of the form. -->
          <div class="mt-5 flex-shrink-0">
            <div class="flex items-center justify-between gap-4 mb-2">
              <label for="attachments" class="block text-sm font-semibold text-gray-700 dark:text-gray-300">{{ t("compose.attachments") }}</label>
              <span class="text-xs" :class="attachmentsTooLarge ? 'text-red-600 dark:text-red-400 font-semibold' : 'text-gray-500 dark:text-gray-400'">
                {{ t("compose.attachmentTotal", { size: formatBytes(attachmentBytes), max: formatBytes(MAX_TOTAL_ATTACHMENT_BYTES) }) }}
              </span>
            </div>
            <input
              ref="attachmentInput"
              id="attachments"
              type="file"
              multiple
              :disabled="isLoading || isReadingAttachments"
              @change="onAttachmentsChosen"
              class="block w-full text-sm text-gray-700 dark:text-gray-300 file:me-3 file:px-4 file:py-2 file:rounded-lg file:border-0 file:bg-gray-800 dark:file:bg-gray-200 file:text-white dark:file:text-gray-900 file:font-medium file:cursor-pointer disabled:opacity-60"
            />
            <ul v-if="attachments.length" class="mt-3 divide-y divide-gray-200 dark:divide-gray-700 border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
              <li v-for="att in attachments" :key="att.id" class="flex items-center justify-between gap-3 px-4 py-2">
                <span class="text-sm text-gray-800 dark:text-gray-200 truncate">{{ att.filename }}</span>
                <span class="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">{{ formatBytes(att.size) }}</span>
                <button
                  type="button"
                  @click="removeAttachment(att.id)"
                  :disabled="isLoading"
                  class="text-sm text-red-600 dark:text-red-400 hover:underline whitespace-nowrap disabled:opacity-50"
                >
                  {{ t("compose.removeAttachment") }}
                </button>
              </li>
            </ul>
            <p v-if="attachmentsTooLarge" class="mt-2 text-sm text-red-600 dark:text-red-400">
              {{ t("compose.attachmentTooLarge", { max: formatBytes(MAX_TOTAL_ATTACHMENT_BYTES) }) }}
            </p>
            <!-- Said before a draft is saved rather than after, because the
                 loss is silent otherwise: the draft comes back without them. -->
            <p v-else-if="attachments.length" class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              {{ t("compose.attachmentDraftNote") }}
            </p>
          </div>
        </div>
        <div class="flex justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex-shrink-0">
          <button
            type="button"
            @click="saveDraft"
            :disabled="isSavingDraft || isLoading"
            class="px-6 py-3 bg-gray-100 dark:bg-gray-700/60 text-gray-700 dark:text-gray-300 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-600 font-semibold transition-all duration-200 disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {{ isSavingDraft ? t('compose.savingDraft') : t('compose.saveDraft') }}
          </button>
          <button
            type="button"
            @click="closeModal"
            class="px-6 py-3 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-xl hover:bg-gray-300 dark:hover:bg-gray-600 font-semibold transition-all duration-200"
          >
            {{ t("compose.cancel") }}
          </button>
          <button
            type="submit"
            :disabled="isLoading"
            class="px-6 py-3 bg-gradient-to-r from-indigo-600 to-purple-600 text-white rounded-xl hover:from-indigo-700 hover:to-purple-700 font-semibold shadow-lg hover:shadow-xl transition-all duration-200 flex items-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
          >
            <svg v-if="!isLoading" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
            <svg v-else class="w-5 h-5 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            {{ isLoading ? t('compose.sending') : t('compose.send') }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { useDateFormat } from "@/composables/useDateFormat";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import { useToast } from "@/composables/useToast";
import api from "@/services/api";
import { useEmailStore } from "@/stores/emails";
import { useMailboxStore } from "@/stores/mailboxes";
import { useUIStore } from "@/stores/ui";
import { splitAddresses } from "@/utils/addresses";
import {
	fileToAttachment,
	formatBytes,
	MAX_TOTAL_ATTACHMENT_BYTES,
	type PendingAttachment,
	totalAttachmentBytes,
} from "@/utils/attachments";
import {
	htmlToPlainText,
	plainTextToSimpleHtml,
} from "@/utils/htmlToPlainText";
import { toQuotableHtml } from "@/utils/quotedBody";
import RichTextEditor from "./RichTextEditor.vue";

const uiStore = useUIStore();
const { isComposeModalOpen, composeOptions } = storeToRefs(uiStore);
const emailStore = useEmailStore();
const mailboxStore = useMailboxStore();
const { currentMailbox } = storeToRefs(mailboxStore);
const route = useRoute();
const { success: showSuccessToast, error: showErrorToast } = useToast();
const { t } = useI18n();

const to = ref("");
const cc = ref("");
const bcc = ref("");
// Cc and Bcc stay hidden until asked for, and stay open once a mode or a
// draft has put something in them.
const showCcBcc = ref(false);
const subject = ref("");
const body = ref("");
const plainBody = ref("");
const isPlainText = ref(false);
// What the HTML body was when plain-text mode was switched on, and the text
// we produced from it, so an untouched round trip can be undone exactly.
const htmlBeforePlainText = ref<string | null>(null);
const generatedPlainText = ref<string | null>(null);
const draftId = ref<string | null>(null);
const error = useLocalizedMessage();

const attachments = ref<PendingAttachment[]>([]);
const attachmentInput = ref<HTMLInputElement | null>(null);
const isReadingAttachments = ref(false);
const attachmentBytes = computed(() => totalAttachmentBytes(attachments.value));
const attachmentsTooLarge = computed(
	() => attachmentBytes.value > MAX_TOTAL_ATTACHMENT_BYTES,
);

/**
 * Files are read and encoded as they are picked, not at send time, so an
 * unreadable file is reported while the dialog is still open rather than
 * turning into a failed send.
 *
 * The input is cleared afterwards so that picking the same file again still
 * fires a change event -- a browser does not re-fire for an unchanged value,
 * and a person who removed a file by mistake would find they could not add it
 * back.
 */
async function onAttachmentsChosen(event: Event) {
	const input = event.target as HTMLInputElement;
	const picked = Array.from(input.files ?? []);
	if (!picked.length) return;

	isReadingAttachments.value = true;
	try {
		const read = await Promise.all(picked.map(fileToAttachment));
		attachments.value = [...attachments.value, ...read];
	} catch {
		error.value = () => t("compose.attachmentReadFailed");
	} finally {
		isReadingAttachments.value = false;
		if (attachmentInput.value) attachmentInput.value.value = "";
	}
}

function removeAttachment(id: string) {
	attachments.value = attachments.value.filter((att) => att.id !== id);
}

function clearAttachments() {
	attachments.value = [];
	if (attachmentInput.value) attachmentInput.value.value = "";
}
const isLoading = ref(false);
const isSavingDraft = ref(false);

const modalTitle = computed(() => {
	switch (composeOptions.value.mode) {
		case "reply":
			return t("compose.modalTitle.reply");
		case "reply-all":
			return t("compose.modalTitle.replyAll");
		case "forward":
			return t("compose.modalTitle.forward");
		case "draft":
			return t("compose.modalTitle.draft");
		default:
			return t("compose.modalTitle.new");
	}
});

const { formatFullDate } = useDateFormat();

/**
 * The header above a quote, and the quote itself.
 *
 * Both halves used to be wrong. The date went in as whatever string the API
 * returned, so the reader was shown a raw ISO timestamp
 * ("2026-08-31T05:39:23.339Z") rather than a date in their own language; and
 * the body went in as stored, which for a plain-text message means a single
 * `<pre>` that the editor turns into one indivisible code block. See
 * toQuotableHtml.
 */
const quoteHeader = (original: { date: string; sender: string }) =>
	t("compose.replyQuotePrefix", {
		date: formatFullDate(original.date),
		sender: original.sender,
	});

const quotedBlock = (original: {
	date: string;
	sender: string;
	body: string;
}) =>
	`<blockquote style="border-left: 2px solid #ccc; margin: 0; padding-left: 1em; color: #666;"><p>${quoteHeader(original)}</p>${toQuotableHtml(original.body)}</blockquote>`;

// Format quoted text for replies
const formatQuotedText = (text: string) => {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
};

const closeModal = () => {
	error.value = null;
	to.value = "";
	cc.value = "";
	bcc.value = "";
	showCcBcc.value = false;
	subject.value = "";
	body.value = "";
	plainBody.value = "";
	isPlainText.value = false;
	htmlBeforePlainText.value = null;
	generatedPlainText.value = null;
	draftId.value = null;
	uiStore.closeComposeModal();
};

// Build signature HTML block if enabled
const getSignatureBlock = (): string => {
	const sig = currentMailbox.value?.settings?.signature;
	if (sig?.enabled && (sig?.html || sig?.text)) {
		const escapeHtml = (s: string) =>
			s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		const content = sig.html || escapeHtml(sig.text);
		return `<div style="border-top: 1px solid #ccc; margin-top: 16px; padding-top: 12px;">${content}</div>`;
	}
	return "";
};

// Watch for compose modal opening and pre-populate fields
watch(isComposeModalOpen, (isOpen) => {
	if (isOpen) {
		const options = composeOptions.value;
		const original = options.originalEmail;
		const sigBlock = getSignatureBlock();

		isPlainText.value = false;
		plainBody.value = "";
		draftId.value = null;
		cc.value = "";
		bcc.value = "";
		showCcBcc.value = false;
		// Files picked for the last message must never ride along on the next
		// one: an attachment sent to the wrong person cannot be recalled.
		clearAttachments();

		if (options.mode === "draft" && original) {
			to.value = original.recipient || "";
			cc.value = original.cc || "";
			bcc.value = original.bcc || "";
			// A draft that has either of them must show both fields, or the
			// addresses would be sent from a form that never displayed them.
			showCcBcc.value = Boolean(cc.value || bcc.value);
			subject.value = original.subject || "";
			body.value = original.body || "";
			draftId.value = original.id;
		} else if (options.mode === "reply" && original) {
			to.value = original.sender;
			subject.value = original.subject.startsWith("Re: ")
				? original.subject
				: `Re: ${original.subject}`;
			body.value = `<p><br></p>${sigBlock}${quotedBlock(original)}`;
		} else if (options.mode === "reply-all" && original) {
			// Everyone who saw the original, minus this mailbox: the sender and
			// the other To: addresses go to To, the original Cc: stays Cc. The
			// stored fields are comma-separated lists, so a message with
			// several recipients contributes several addresses here.
			const self = currentMailbox.value?.email;
			const isOther = (address: string) => address !== self;
			const toList = [
				original.sender,
				...splitAddresses(original.recipient || ""),
			].filter(isOther);
			const ccList = splitAddresses(original.cc || "").filter(isOther);
			to.value = Array.from(new Set(toList)).join(", ");
			cc.value = Array.from(new Set(ccList)).join(", ");
			showCcBcc.value = cc.value.length > 0;
			subject.value = original.subject.startsWith("Re: ")
				? original.subject
				: `Re: ${original.subject}`;
			body.value = `<p><br></p>${sigBlock}${quotedBlock(original)}`;
		} else if (options.mode === "forward" && original) {
			to.value = "";
			subject.value = original.subject.startsWith("Fwd: ")
				? original.subject
				: `Fwd: ${original.subject}`;
			body.value = `<p><br></p>${sigBlock}<div style="border: 1px solid #ddd; padding: 1em; background-color: #f9f9f9; margin: 1em 0;"><p><strong>${t("compose.forwardedMessage")}</strong><br><strong>${t("compose.forwardFrom")}</strong> ${original.sender}<br><strong>${t("compose.forwardDate")}</strong> ${formatFullDate(original.date)}<br><strong>${t("compose.forwardSubject")}</strong> ${original.subject}</p>${toQuotableHtml(original.body)}</div>`;
		} else {
			to.value = "";
			subject.value = "";
			body.value = sigBlock ? `<br><br>${sigBlock}` : "";
		}
	}
});

watch(isPlainText, (usePlainText) => {
	if (usePlainText) {
		htmlBeforePlainText.value = body.value;
		const text = htmlToPlainText(body.value);
		// The conversion trims leading blank lines, which is right for the
		// text/plain part of a finished message but wrong here: on a reply the
		// quote would then start on line one, with nowhere to write above it.
		plainBody.value = text.startsWith(">") ? `\n\n${text}` : text;
		generatedPlainText.value = plainBody.value;
		return;
	}

	// Going back the other way is lossy: formatting, the quote's blockquote
	// and the signature block are all gone once the body is plain text. If
	// the text is still exactly what we generated, the user only looked at
	// it, so hand back the original HTML rather than a flattened copy.
	if (
		htmlBeforePlainText.value !== null &&
		plainBody.value === generatedPlainText.value
	) {
		body.value = htmlBeforePlainText.value;
	} else {
		body.value = plainTextToSimpleHtml(plainBody.value);
	}
	htmlBeforePlainText.value = null;
	generatedPlainText.value = null;
});

const saveDraft = async () => {
	error.value = null;
	if (!currentMailbox.value) {
		error.value = () => t("compose.noMailboxSelected");
		return;
	}
	isSavingDraft.value = true;
	try {
		const mailboxId = route.params.mailboxId as string;
		// A draft keeps the raw text of each address field, unsplit, so a
		// half-typed address survives a save.
		const draftData = {
			to: to.value,
			cc: cc.value,
			bcc: bcc.value,
			from: currentMailbox.value.email,
			subject: subject.value,
			html: isPlainText.value ? plainBody.value : body.value,
		};

		if (draftId.value) {
			await api.updateDraft(mailboxId, draftId.value, draftData);
		} else {
			const response = await api.saveDraft(mailboxId, draftData);
			draftId.value = response.data.id;
		}

		showSuccessToast(t("compose.draftSaved"));
	} catch (e: any) {
		const fromApi = e.response?.data?.error;
		const errorMessage = () => fromApi || t("compose.unexpectedError");
		error.value = errorMessage;
		showErrorToast(errorMessage());
	} finally {
		isSavingDraft.value = false;
	}
};

const send = async () => {
	error.value = null;
	if (!currentMailbox.value) {
		error.value = () => t("compose.noMailboxSelected");
		return;
	}
	// Refused here rather than sent and rejected: an oversized request would
	// come back as an error from Resend or the Worker, by which time the
	// whole encoded body has been uploaded for nothing.
	if (attachmentsTooLarge.value) {
		error.value = () =>
			t("compose.attachmentTooLarge", {
				max: formatBytes(MAX_TOTAL_ATTACHMENT_BYTES),
			});
		return;
	}
	isLoading.value = true;
	try {
		const mailboxId = route.params.mailboxId as string;
		// The API takes address lists as arrays; the fields hold the
		// comma-separated text the user typed.
		const recipients = {
			to: splitAddresses(to.value),
			cc: splitAddresses(cc.value),
			bcc: splitAddresses(bcc.value),
		};
		// Omitted entirely rather than sent as [], which the API rejects.
		const attached = attachments.value.length
			? {
					attachments: attachments.value.map((att) => ({
						content: att.content,
						filename: att.filename,
						type: att.type,
						disposition: "attachment" as const,
					})),
				}
			: {};

		const emailData = isPlainText.value
			? {
					...recipients,
					...attached,
					from: currentMailbox.value.email,
					subject: subject.value,
					text: plainBody.value,
				}
			: {
					...recipients,
					...attached,
					from: currentMailbox.value.email,
					subject: subject.value,
					html: body.value,
					text: htmlToPlainText(body.value),
				};

		// Use appropriate API endpoint based on mode
		if (
			composeOptions.value.mode === "reply" ||
			composeOptions.value.mode === "reply-all"
		) {
			const originalEmailId = composeOptions.value.originalEmail?.id;
			if (originalEmailId) {
				await api.replyToEmail(mailboxId, originalEmailId, emailData);
			} else {
				throw new Error(t("compose.originalEmailNotFound"));
			}
		} else if (composeOptions.value.mode === "forward") {
			const originalEmailId = composeOptions.value.originalEmail?.id;
			if (originalEmailId) {
				await api.forwardEmail(mailboxId, originalEmailId, emailData);
			} else {
				throw new Error(t("compose.originalEmailNotFound"));
			}
		} else {
			await emailStore.sendEmail(mailboxId, emailData);
		}

		if (draftId.value) {
			await api.deleteEmail(mailboxId, draftId.value);
		}

		to.value = "";
		subject.value = "";
		body.value = "";
		clearAttachments();
		closeModal();
		showSuccessToast(t("compose.emailSentSuccess"));
	} catch (e: any) {
		const fromApi = e.response?.data?.error;
		const errorMessage = () => fromApi || t("compose.unexpectedError");
		error.value = errorMessage;
		showErrorToast(errorMessage());
	} finally {
		isLoading.value = false;
	}
};
</script>

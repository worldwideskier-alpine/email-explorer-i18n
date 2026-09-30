import { defineStore } from "pinia";
import api from "@/services/api";
import type { Email } from "@/types";

/**
 * Which search is the latest. A slower, earlier one used to land last and
 * show its results under the newer query -- or, from another mailbox, links
 * to messages this mailbox does not have.
 */
let latest = 0;

export const useSearchStore = defineStore("search", {
	state: () => ({
		results: [] as Email[],
		/** Which mailbox the results are from. */
		mailboxId: "",
		/** What was searched for, so a failed search can be asked again. */
		query: "",
		isLoading: false,
		/**
		 * The latest search failed. Without it a search that could not be
		 * made read "No results found", which is an answer about the mail.
		 */
		failed: false,
	}),
	actions: {
		/**
		 * Never throws: a failure is recorded for the results screen to say,
		 * rather than rejecting into a header that fires this and moves on.
		 */
		async searchEmails(mailboxId: string, query: string) {
			const request = ++latest;
			this.results = [];
			this.mailboxId = mailboxId;
			this.query = query;
			this.isLoading = true;
			this.failed = false;
			try {
				const response = await api.searchEmails(mailboxId, { query });
				if (request === latest) this.results = response.data;
			} catch {
				if (request === latest) this.failed = true;
			} finally {
				if (request === latest) this.isLoading = false;
			}
		},
	},
});

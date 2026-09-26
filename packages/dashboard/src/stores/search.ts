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
		isLoading: false,
	}),
	actions: {
		async searchEmails(mailboxId: string, query: string) {
			const request = ++latest;
			this.results = [];
			this.mailboxId = mailboxId;
			this.isLoading = true;
			try {
				const response = await api.searchEmails(mailboxId, { query });
				if (request === latest) this.results = response.data;
			} finally {
				if (request === latest) this.isLoading = false;
			}
		},
	},
});

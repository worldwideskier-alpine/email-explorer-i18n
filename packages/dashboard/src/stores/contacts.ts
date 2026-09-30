import { defineStore } from "pinia";
import api from "@/services/api";
import type { Contact } from "@/types";

/** Which request for contacts is the latest; see fetchContacts. */
let latestContacts = 0;

export const useContactStore = defineStore("contacts", {
	state: () => ({
		contacts: [] as Contact[],
	}),
	actions: {
		async fetchContacts(mailboxId: string) {
			// Dropped first, so a failed load does not leave another
			// mailbox's contacts on screen under this one.
			this.contacts = [];
			// And only the latest answer is kept: moving to another mailbox
			// while this one's list was on its way let it land afterwards,
			// under the other mailbox's name.
			const request = ++latestContacts;
			const response = await api.listContacts(mailboxId);
			if (request === latestContacts) this.contacts = response.data;
		},
		// Only listing: no screen makes, changes or removes a contact. The
		// actions for it sat here unused; the Worker's routes remain for
		// anyone using the API directly.
	},
});

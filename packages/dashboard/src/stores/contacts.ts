import { defineStore } from "pinia";
import api from "@/services/api";
import type { Contact } from "@/types";

export const useContactStore = defineStore("contacts", {
	state: () => ({
		contacts: [] as Contact[],
	}),
	actions: {
		async fetchContacts(mailboxId: string) {
			// Dropped first, so a failed load does not leave another
			// mailbox's contacts on screen under this one.
			this.contacts = [];
			const response = await api.listContacts(mailboxId);
			this.contacts = response.data;
		},
		// Only listing: no screen makes, changes or removes a contact. The
		// actions for it sat here unused; the Worker's routes remain for
		// anyone using the API directly.
	},
});

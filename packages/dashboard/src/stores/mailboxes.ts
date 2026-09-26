import { defineStore } from "pinia";
import api from "@/services/api";
import type { Mailbox } from "@/types";

let latestMailbox = 0;

export const useMailboxStore = defineStore("mailboxes", {
	state: () => ({
		mailboxes: [] as Mailbox[],
		currentMailbox: null as Mailbox | null,
	}),
	actions: {
		async fetchMailboxes() {
			const response = await api.listMailboxes();
			this.mailboxes = response.data;
		},
		/**
		 * The previous mailbox is dropped before the next is asked for, and a
		 * late answer for a mailbox no longer asked for is ignored. It used
		 * to stay until the new one arrived -- or for good, if that failed --
		 * and the settings screen, saving meanwhile, wrote the previous
		 * mailbox's sender name and settings into this one.
		 */
		async fetchMailbox(id: string) {
			if (this.currentMailbox?.id !== id) this.currentMailbox = null;
			const request = ++latestMailbox;
			const response = await api.getMailbox(id);
			if (request === latestMailbox) this.currentMailbox = response.data;
		},
		async updateMailbox(id: string, settings: any) {
			const response = await api.updateMailbox(id, settings);
			this.currentMailbox = response.data;
		},
		async deleteMailbox(id: string, purge = false) {
			await api.deleteMailbox(id, purge);
			this.mailboxes = this.mailboxes.filter((mailbox) => mailbox.id !== id);
			if (this.currentMailbox?.id === id) this.currentMailbox = null;
		},
	},
});

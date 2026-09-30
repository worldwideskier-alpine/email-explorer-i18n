import { defineStore } from "pinia";
import api from "@/services/api";
import type { Folder } from "@/types";

/** Which request for folders is the latest; see fetchFolders. */
let latestFolders = 0;

export const useFolderStore = defineStore("folders", {
	state: () => ({
		folders: [] as Folder[],
		/** Whose folders these are. */
		mailboxId: "",
	}),
	actions: {
		/**
		 * Another mailbox's folders go before its request, and an answer for
		 * a mailbox no longer asked about is dropped -- the same as the
		 * mailbox itself (mailboxes.ts). Otherwise a sidebar moved to a new
		 * mailbox listed the last one's folders until, or unless, it answered.
		 */
		async fetchFolders(mailboxId: string) {
			if (this.mailboxId !== mailboxId) {
				this.folders = [];
				this.mailboxId = mailboxId;
			}
			const request = ++latestFolders;
			const response = await api.listFolders(mailboxId);
			if (request === latestFolders) this.folders = response.data;
		},
		async createFolder(mailboxId: string, name: string) {
			const response = await api.createFolder(mailboxId, name);
			// Into this mailbox's list only: made in one and answered after
			// moving to another, it was added to the other's sidebar.
			if (this.mailboxId === mailboxId) this.folders.push(response.data);
		},
		async updateFolder(mailboxId: string, id: string, name: string) {
			const response = await api.updateFolder(mailboxId, id, name);
			const index = this.folders.findIndex((folder) => folder.id === id);
			if (index !== -1) {
				this.folders[index] = response.data;
			}
		},
		async deleteFolder(mailboxId: string, id: string) {
			await api.deleteFolder(mailboxId, id);
			this.folders = this.folders.filter((folder) => folder.id !== id);
		},
	},
});

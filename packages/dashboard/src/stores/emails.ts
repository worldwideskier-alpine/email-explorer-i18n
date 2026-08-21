import { defineStore } from "pinia";
import api from "@/services/api";
import type { Email } from "@/types";

/** Rows fetched per scroll step; also the server's own default page size. */
const PAGE_SIZE = 25;

export const useEmailStore = defineStore("emails", {
	state: () => ({
		emails: [] as Email[],
		currentEmail: null as Email | null,
		isRefreshing: false,
		isLoadingMore: false,
		/** False once a short page proves there is nothing left to scroll to. */
		hasMore: false,
		loadedPages: 1,
		/** Which mailbox+folder the loaded pages belong to. */
		listKey: "",
	}),
	actions: {
		/**
		 * Loads the first `pages` pages in a single request.
		 *
		 * Re-reading everything (rather than appending page n+1) keeps the list
		 * exact: rows deleted or moved out of the folder shift the server-side
		 * window, so an appended page would silently skip messages. Only email
		 * metadata is fetched, so a few hundred rows stay cheap.
		 */
		async loadEmailPages(mailboxId: string, params: any, pages: number) {
			const limit = PAGE_SIZE * pages;
			const response = await api.listEmails(mailboxId, {
				...params,
				page: 1,
				limit,
			});
			this.emails = response.data;
			this.loadedPages = pages;
			this.hasMore = response.data.length >= limit;
			this.listKey = `${mailboxId}/${params?.folder ?? ""}`;
		},
		async fetchEmails(mailboxId: string, params: any) {
			// A background refresh must not throw away pages the reader has
			// already scrolled into view, so reload as many as are on screen.
			const sameList = this.listKey === `${mailboxId}/${params?.folder ?? ""}`;
			const pages = sameList ? Math.max(this.loadedPages, 1) : 1;
			this.isRefreshing = true;
			try {
				await this.loadEmailPages(mailboxId, params, pages);
			} finally {
				this.isRefreshing = false;
			}
		},
		/** Extends the list by one page; a no-op once the end has been reached. */
		async fetchMoreEmails(mailboxId: string, params: any) {
			if (this.isLoadingMore || this.isRefreshing || !this.hasMore) return;
			this.isLoadingMore = true;
			try {
				await this.loadEmailPages(mailboxId, params, this.loadedPages + 1);
			} finally {
				this.isLoadingMore = false;
			}
		},
		async fetchEmail(mailboxId: string, id: string) {
			const response = await api.getEmail(mailboxId, id);
			this.currentEmail = response.data;
		},
		async sendEmail(mailboxId: string, email: any) {
			await api.sendEmail(mailboxId, email);
		},
		async updateEmail(mailboxId: string, id: string, data: any) {
			const response = await api.updateEmail(mailboxId, id, data);
			const updatedEmail = response.data;
			const index = this.emails.findIndex((email) => email.id === id);
			if (index !== -1) {
				this.emails[index] = { ...this.emails[index], ...updatedEmail };
			}
			if (this.currentEmail && this.currentEmail.id === id) {
				this.currentEmail = { ...this.currentEmail, ...updatedEmail };
			}
		},
		async deleteEmail(mailboxId: string, id: string) {
			await api.deleteEmail(mailboxId, id);
			this.emails = this.emails.filter((email) => email.id !== id);
		},
		async moveEmail(mailboxId: string, id: string, folderId: string) {
			await api.moveEmail(mailboxId, id, folderId);
			this.emails = this.emails.filter((email) => email.id !== id);
		},
		async deleteOrTrashEmail(
			mailboxId: string,
			id: string,
			currentFolderId: string,
		) {
			if (currentFolderId === "trash") {
				await this.deleteEmail(mailboxId, id);
			} else {
				await this.moveEmail(mailboxId, id, "trash");
			}
		},
		async setEmailSpamVerdict(
			mailboxId: string,
			id: string,
			verdict: "spam" | "not-spam",
		) {
			await api.setEmailSpamVerdict(mailboxId, id, verdict);
			this.emails = this.emails.filter((email) => email.id !== id);
		},
	},
});

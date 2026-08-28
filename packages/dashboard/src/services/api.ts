import axios from "axios";

const apiClient = axios.create({
	baseURL: "",
	headers: {
		"Content-Type": "application/json",
	},
});

// Request interceptor to add auth token
apiClient.interceptors.request.use(
	(config) => {
		const session = localStorage.getItem("session");
		if (session) {
			try {
				const parsed = JSON.parse(session);
				config.headers.Authorization = `Bearer ${parsed.id}`;
			} catch (e) {
				// Invalid session, ignore
			}
		}
		return config;
	},
	(error) => Promise.reject(error),
);

// Response interceptor to handle 401
apiClient.interceptors.response.use(
	(response) => response,
	async (error) => {
		if (error.response?.status === 401) {
			// Clear auth and redirect to login
			localStorage.removeItem("session");
			if (window.location.pathname !== "/login") {
				window.location.href = "/login";
			}
		}
		return Promise.reject(error);
	},
);

export default {
	// Settings
	getAppSettings: () => apiClient.get("/api/v1/settings"),

	// Auth
	register: (email: string, password: string) =>
		apiClient.post("/api/v1/auth/register", { email, password }),
	login: (email: string, password: string) =>
		apiClient.post("/api/v1/auth/login", { email, password }),
	logout: () => apiClient.post("/api/v1/auth/logout"),
	getCurrentUser: () => apiClient.get("/api/v1/auth/me"),
	// The locale travels with the request because the recovery mail is written
	// server-side: it should arrive in the language the user is reading.
	forgotPassword: (email: string, locale: string) =>
		apiClient.post("/api/v1/auth/forgot-password", { email, locale }),
	resetPassword: (token: string, newPassword: string) =>
		apiClient.post("/api/v1/auth/reset-password", { token, newPassword }),

	// Set/clear auth token manually
	setAuthToken: (token: string) => {
		apiClient.defaults.headers.common["Authorization"] = `Bearer ${token}`;
	},
	clearAuthToken: () => {
		delete apiClient.defaults.headers.common["Authorization"];
	},

	// Mailboxes
	listMailboxes: () => apiClient.get("/api/v1/mailboxes"),
	createMailbox: (email: string, name: string, settings?: any) =>
		apiClient.post("/api/v1/mailboxes", { email, name, settings }),
	getMailbox: (mailboxId: string) =>
		apiClient.get(`/api/v1/mailboxes/${mailboxId}`),
	updateMailbox: (mailboxId: string, settings: any) =>
		apiClient.put(`/api/v1/mailboxes/${mailboxId}`, { settings }),
	// purge also destroys the stored mail; without it the mailbox is only
	// unlisted and its messages survive.
	deleteMailbox: (mailboxId: string, purge = false) =>
		apiClient.delete(`/api/v1/mailboxes/${mailboxId}`, {
			params: purge ? { purge: "true" } : undefined,
		}),

	// Emails
	listEmails: (mailboxId: string, params: any) =>
		apiClient.get(`/api/v1/mailboxes/${mailboxId}/emails`, { params }),
	sendEmail: (mailboxId: string, email: any) =>
		apiClient.post(`/api/v1/mailboxes/${mailboxId}/emails`, email),
	getEmail: (mailboxId: string, id: string) =>
		apiClient.get(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	getEmailSource: (mailboxId: string, id: string) =>
		apiClient.get(`/api/v1/mailboxes/${mailboxId}/emails/${id}/source`, {
			responseType: "text",
		}),
	// Fetched through this client, not linked to directly: a plain link opens
	// a new browsing context that carries neither the Authorization header nor
	// (from the installed PWA) the session cookie, and the download comes back
	// as {"error":"Unauthorized"}.
	downloadAttachment: (mailboxId: string, id: string, attachmentId: string) =>
		apiClient.get(
			`/api/v1/mailboxes/${mailboxId}/emails/${id}/attachments/${attachmentId}`,
			{ responseType: "blob" },
		),
	updateEmail: (mailboxId: string, id: string, data: any) =>
		apiClient.put(`/api/v1/mailboxes/${mailboxId}/emails/${id}`, data),
	deleteEmail: (mailboxId: string, id: string) =>
		apiClient.delete(`/api/v1/mailboxes/${mailboxId}/emails/${id}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		apiClient.post(`/api/v1/mailboxes/${mailboxId}/emails/${id}/move`, {
			folderId,
		}),
	setEmailSpamVerdict: (
		mailboxId: string,
		id: string,
		verdict: "spam" | "not-spam",
	) =>
		apiClient.post(`/api/v1/mailboxes/${mailboxId}/emails/${id}/spam-verdict`, {
			verdict,
		}),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		apiClient.get(
			`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/attachments/${attachmentId}`,
			{ responseType: "blob" },
		),
	replyToEmail: (mailboxId: string, emailId: string, email: any) =>
		apiClient.post(
			`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/reply`,
			email,
		),
	forwardEmail: (mailboxId: string, emailId: string, email: any) =>
		apiClient.post(
			`/api/v1/mailboxes/${mailboxId}/emails/${emailId}/forward`,
			email,
		),
	saveDraft: (mailboxId: string, draft: any) =>
		apiClient.post(`/api/v1/mailboxes/${mailboxId}/drafts`, draft),
	updateDraft: (mailboxId: string, id: string, draft: any) =>
		apiClient.put(`/api/v1/mailboxes/${mailboxId}/drafts/${id}`, draft),

	// Folders
	listFolders: (mailboxId: string) =>
		apiClient.get(`/api/v1/mailboxes/${mailboxId}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		apiClient.post(`/api/v1/mailboxes/${mailboxId}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		apiClient.put(`/api/v1/mailboxes/${mailboxId}/folders/${id}`, { name }),
	deleteFolder: (mailboxId: string, id: string) =>
		apiClient.delete(`/api/v1/mailboxes/${mailboxId}/folders/${id}`),

	// Contacts
	listContacts: (mailboxId: string) =>
		apiClient.get(`/api/v1/mailboxes/${mailboxId}/contacts`),
	createContact: (mailboxId: string, contact: any) =>
		apiClient.post(`/api/v1/mailboxes/${mailboxId}/contacts`, contact),
	updateContact: (mailboxId: string, id: string, contact: any) =>
		apiClient.put(`/api/v1/mailboxes/${mailboxId}/contacts/${id}`, contact),
	deleteContact: (mailboxId: string, id: string) =>
		apiClient.delete(`/api/v1/mailboxes/${mailboxId}/contacts/${id}`),

	// Search
	searchEmails: (mailboxId: string, params: any) =>
		apiClient.get(`/api/v1/mailboxes/${mailboxId}/search`, { params }),

	// Admin
	adminRegisterUser: (email: string, password: string) =>
		apiClient.post("/api/v1/auth/admin/register", { email, password }),
	adminListUsers: () => apiClient.get("/api/v1/auth/admin/users"),
	adminGrantAccess: (userId: string, mailboxId: string, role: string) =>
		apiClient.post("/api/v1/auth/admin/grant-access", {
			userId,
			mailboxId,
			role,
		}),
	adminRevokeAccess: (userId: string, mailboxId: string) =>
		apiClient.post("/api/v1/auth/admin/revoke-access", { userId, mailboxId }),

	// Push notifications
	getVapidPublicKey: () => apiClient.get("/api/v1/push/vapid-public-key"),
	subscribePush: (subscription: PushSubscriptionJSON) =>
		apiClient.post("/api/v1/push/subscribe", subscription),
	unsubscribePush: (endpoint: string) =>
		apiClient.post("/api/v1/push/unsubscribe", { endpoint }),
};

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

/**
 * Endpoints where a 401 says something about the request rather than about
 * the session: a token in the body that has expired, or credentials being
 * checked. Signing the user out over one of those would throw away the very
 * screen that is supposed to show them what went wrong.
 */
const OWN_401_HANDLING = [
	"/api/v1/auth/login",
	"/api/v1/auth/reset-password",
	"/api/v1/auth/confirm-email-change",
];

// Response interceptor: a 401 anywhere else means the session is gone.
apiClient.interceptors.response.use(
	(response) => response,
	async (error) => {
		const url: string = error.config?.url ?? "";
		const handledByCaller = OWN_401_HANDLING.some((path) =>
			url.startsWith(path),
		);
		if (error.response?.status === 401 && !handledByCaller) {
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
	changePassword: (currentPassword: string, newPassword: string) =>
		apiClient.post("/api/v1/auth/change-password", {
			currentPassword,
			newPassword,
		}),
	changeEmail: (currentPassword: string, newEmail: string, locale: string) =>
		apiClient.post("/api/v1/auth/change-email", {
			currentPassword,
			newEmail,
			locale,
		}),
	confirmEmailChange: (token: string) =>
		apiClient.post("/api/v1/auth/confirm-email-change", { token }),

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

	// The whole mailbox as an mbox archive. Fetched as a blob through this
	// client because the endpoint needs the session; see exportMailbox in
	// Settings.vue for why that caps the practical size.
	exportMailbox: (mailboxId: string) =>
		apiClient.get(`/api/v1/mailboxes/${mailboxId}/export`, {
			responseType: "blob",
		}),

	// One message back into the mailbox, admin only. A restore posts these one
	// at a time rather than handing over the whole archive: an mbox can be far
	// larger than a Worker request may carry, and a message at a time is what
	// lets the page show progress and pick up where it stopped.
	//
	// `id` is what makes it safe to run twice -- the Worker answers
	// status "duplicate" and writes nothing for a message already there.
	importEmail: (
		mailboxId: string,
		message: {
			rawEmailBase64: string;
			folder: string;
			id?: string;
			date?: string;
			read?: boolean;
			starred?: boolean;
		},
	) => apiClient.post(`/api/v1/admin/mailboxes/${mailboxId}/import`, message),

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
	adminSetUserAdmin: (userId: string, isAdmin: boolean) =>
		apiClient.put(`/api/v1/auth/admin/users/${userId}`, { isAdmin }),
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

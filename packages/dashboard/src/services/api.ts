import axios from "axios";
import { somethingIsBeingWritten } from "./appUpdate";

/** Exported for tests, which answer its requests themselves. */
export const apiClient = axios.create({
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
	// Asked by checkAuth and logout, which deal with a stale session
	// themselves -- and are asked on the first navigation of every page.
	"/api/v1/auth/me",
	"/api/v1/auth/logout",
];

/**
 * Pages that are for people without a session. A stale session stored in the
 * browser used to send these to /login -- the reset link opened from an email
 * among them, token and all, so the link could not be used.
 */
const PUBLIC_PAGES = [
	"/login",
	"/register",
	"/forgot-password",
	"/reset-password",
	"/confirm-email-change",
];

/** How the page is sent to sign in; a test watches it rather than jsdom. */
export const leave = {
	to(url: string) {
		window.location.href = url;
	},
};

// Response interceptor: a 401 anywhere else means the session is gone.
apiClient.interceptors.response.use(
	(response) => response,
	async (error) => {
		const url: string = error.config?.url ?? "";
		const handledByCaller = OWN_401_HANDLING.some((path) =>
			url.startsWith(path),
		);
		if (error.response?.status === 401 && !handledByCaller) {
			localStorage.removeItem("session");
			// Not while somebody is writing. Navigating away threw the unsent
			// message out with the session -- the one thing appUpdate.ts
			// already refuses to do. The failed send says so, the text stays
			// to be copied, and the next navigation goes to sign-in.
			if (
				!PUBLIC_PAGES.includes(window.location.pathname) &&
				!somethingIsBeingWritten(document)
			) {
				const here = window.location.pathname + window.location.search;
				leave.to(`/login?redirect=${encodeURIComponent(here)}`);
			}
		}
		return Promise.reject(error);
	},
);

/**
 * One path segment, encoded. Ids and addresses went into the path as they
 * were, and they come from route params and stored rows: an attachment or
 * backup name is somebody else's to choose, and a "/", "?" or "#" in one
 * named another path. The Worker reads the encoded form back as the same
 * value (encoded-path.test.ts on its side).
 */
const seg = (value: string | number) => encodeURIComponent(String(value));

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
		apiClient.get(`/api/v1/mailboxes/${seg(mailboxId)}`),
	updateMailbox: (mailboxId: string, settings: any) =>
		apiClient.put(`/api/v1/mailboxes/${seg(mailboxId)}`, { settings }),
	// purge also destroys the stored mail; without it the mailbox is only
	// unlisted and its messages survive.
	deleteMailbox: (mailboxId: string, purge = false) =>
		apiClient.delete(`/api/v1/mailboxes/${seg(mailboxId)}`, {
			params: purge ? { purge: "true" } : undefined,
		}),

	// Puts the stored Claude key to the API once and reports what came back.
	// Without it the only thing that exercises a key is inbound mail, so a key
	// the API refuses looks exactly like one that works until the next message
	// happens to arrive.
	checkSpamFilterKey: (mailboxId: string) =>
		apiClient.post(`/api/v1/mailboxes/${seg(mailboxId)}/spam-filter/check`),

	// The whole mailbox as an mbox archive. Fetched as a blob through this
	// client because the endpoint needs the session; see exportMailbox in
	// Settings.vue for why that caps the practical size.
	exportMailbox: (mailboxId: string) =>
		apiClient.get(`/api/v1/mailboxes/${seg(mailboxId)}/export`, {
			responseType: "blob",
		}),

	// The archives the scheduled run keeps. Listing and downloading only:
	// there is no delete counterpart, on purpose. Rotation inside the
	// scheduled run is the only thing that removes one, so someone who takes
	// over an account here can destroy the mail but not the copies of it.
	listBackups: (mailboxId: string) =>
		apiClient.get(`/api/v1/mailboxes/${seg(mailboxId)}/backups`),
	// Through this client rather than a plain link, for the same reason the
	// export is: a new browsing context carries neither the Authorization
	// header nor the session cookie.
	downloadBackup: (mailboxId: string, name: string) =>
		apiClient.get(`/api/v1/mailboxes/${seg(mailboxId)}/backups/${seg(name)}`, {
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
	) =>
		apiClient.post(`/api/v1/admin/mailboxes/${seg(mailboxId)}/import`, message),

	// Emails
	listEmails: (mailboxId: string, params: any) =>
		apiClient.get(`/api/v1/mailboxes/${seg(mailboxId)}/emails`, { params }),
	sendEmail: (mailboxId: string, email: any) =>
		apiClient.post(`/api/v1/mailboxes/${seg(mailboxId)}/emails`, email),
	getEmail: (mailboxId: string, id: string) =>
		apiClient.get(`/api/v1/mailboxes/${seg(mailboxId)}/emails/${seg(id)}`),
	getEmailSource: (mailboxId: string, id: string) =>
		apiClient.get(
			`/api/v1/mailboxes/${seg(mailboxId)}/emails/${seg(id)}/source`,
			{
				responseType: "text",
			},
		),
	// Fetched through this client, not linked to directly: a plain link opens
	// a new browsing context that carries neither the Authorization header nor
	// (from the installed PWA) the session cookie, and the download comes back
	// as {"error":"Unauthorized"}.
	downloadAttachment: (mailboxId: string, id: string, attachmentId: string) =>
		apiClient.get(
			`/api/v1/mailboxes/${seg(mailboxId)}/emails/${seg(id)}/attachments/${seg(attachmentId)}`,
			{ responseType: "blob" },
		),
	updateEmail: (mailboxId: string, id: string, data: any) =>
		apiClient.put(
			`/api/v1/mailboxes/${seg(mailboxId)}/emails/${seg(id)}`,
			data,
		),
	deleteEmail: (mailboxId: string, id: string) =>
		apiClient.delete(`/api/v1/mailboxes/${seg(mailboxId)}/emails/${seg(id)}`),
	moveEmail: (mailboxId: string, id: string, folderId: string) =>
		apiClient.post(
			`/api/v1/mailboxes/${seg(mailboxId)}/emails/${seg(id)}/move`,
			{
				folderId,
			},
		),
	setEmailSpamVerdict: (
		mailboxId: string,
		id: string,
		verdict: "spam" | "not-spam",
	) =>
		apiClient.post(
			`/api/v1/mailboxes/${seg(mailboxId)}/emails/${seg(id)}/spam-verdict`,
			{
				verdict,
			},
		),
	getAttachment: (mailboxId: string, emailId: string, attachmentId: string) =>
		apiClient.get(
			`/api/v1/mailboxes/${seg(mailboxId)}/emails/${seg(emailId)}/attachments/${seg(attachmentId)}`,
			{ responseType: "blob" },
		),
	replyToEmail: (mailboxId: string, emailId: string, email: any) =>
		apiClient.post(
			`/api/v1/mailboxes/${seg(mailboxId)}/emails/${seg(emailId)}/reply`,
			email,
		),
	forwardEmail: (mailboxId: string, emailId: string, email: any) =>
		apiClient.post(
			`/api/v1/mailboxes/${seg(mailboxId)}/emails/${seg(emailId)}/forward`,
			email,
		),
	saveDraft: (mailboxId: string, draft: any) =>
		apiClient.post(`/api/v1/mailboxes/${seg(mailboxId)}/drafts`, draft),
	updateDraft: (mailboxId: string, id: string, draft: any) =>
		apiClient.put(
			`/api/v1/mailboxes/${seg(mailboxId)}/drafts/${seg(id)}`,
			draft,
		),

	// Folders
	listFolders: (mailboxId: string) =>
		apiClient.get(`/api/v1/mailboxes/${seg(mailboxId)}/folders`),
	createFolder: (mailboxId: string, name: string) =>
		apiClient.post(`/api/v1/mailboxes/${seg(mailboxId)}/folders`, { name }),
	updateFolder: (mailboxId: string, id: string, name: string) =>
		apiClient.put(`/api/v1/mailboxes/${seg(mailboxId)}/folders/${seg(id)}`, {
			name,
		}),
	deleteFolder: (mailboxId: string, id: string) =>
		apiClient.delete(`/api/v1/mailboxes/${seg(mailboxId)}/folders/${seg(id)}`),

	// Contacts
	listContacts: (mailboxId: string) =>
		apiClient.get(`/api/v1/mailboxes/${seg(mailboxId)}/contacts`),
	createContact: (mailboxId: string, contact: any) =>
		apiClient.post(`/api/v1/mailboxes/${seg(mailboxId)}/contacts`, contact),
	updateContact: (mailboxId: string, id: string, contact: any) =>
		apiClient.put(
			`/api/v1/mailboxes/${seg(mailboxId)}/contacts/${seg(id)}`,
			contact,
		),
	deleteContact: (mailboxId: string, id: string) =>
		apiClient.delete(`/api/v1/mailboxes/${seg(mailboxId)}/contacts/${seg(id)}`),

	// Search
	searchEmails: (mailboxId: string, params: any) =>
		apiClient.get(`/api/v1/mailboxes/${seg(mailboxId)}/search`, { params }),

	// Admin
	// The key is never returned by either of these; the response says only
	// whether one is set and which of the two sources it came from.
	adminGetResendSettings: () => apiClient.get("/api/v1/admin/settings/resend"),
	adminSetResendApiKey: (apiKey: string) =>
		apiClient.put("/api/v1/admin/settings/resend", { apiKey }),
	// Root: the people using this deployment. Nothing here returns mail; see
	// routes/root.ts in the Worker for why that is deliberate. There is no
	// transfer: the role belongs to a person, so root's spare login carries
	// it, and nothing hands the deployment to somebody else.
	listAccounts: () => apiClient.get("/api/v1/root/accounts"),
	// Whether the nightly cron finished last time. Each mailbox records what
	// happened to it, which answers "did my backup run" but not "did the run
	// finish" -- and those came apart in production.
	getMaintenance: () => apiClient.get("/api/v1/root/maintenance"),
	createAccount: (
		email: string,
		password: string,
		role: "root" | "admin",
		currentPassword?: string,
	) =>
		apiClient.post("/api/v1/root/accounts", {
			email,
			password,
			role,
			currentPassword,
		}),
	setAccountPassword: (userId: string, password: string) =>
		apiClient.post(`/api/v1/root/accounts/${seg(userId)}/password`, {
			password,
		}),
	// The lock that makes deleting a person two acts instead of one. The
	// Worker refuses the delete below with 423 while it is on, so hiding the
	// button is the courtesy and this is the guard.
	setPersonDeletionLock: (personId: string, locked: boolean) =>
		apiClient.post(`/api/v1/root/accounts/${seg(personId)}/lock`, { locked }),
	deletePerson: (personId: string) =>
		apiClient.delete(`/api/v1/root/accounts/${seg(personId)}`),
	// The bucket against the mail that claims it: counts only, no filename.
	// The repair moves objects onto the name their row gives and loses
	// nothing; the purge deletes what nothing claims and is a separate press
	// for that reason. See attachment-sweep.ts in the Worker.
	sweepAttachments: () => apiClient.get("/api/v1/root/attachments"),
	repairAttachments: () => apiClient.post("/api/v1/root/attachments/repair"),
	purgeAttachments: () => apiClient.post("/api/v1/root/attachments/purge"),

	// Your own logins: the addresses you sign in with. Adding one adds it to
	// you, not to somebody else, and the list holds yours alone.
	// Both ask for the current password: a sign-in address outlasts the
	// session it was added from.
	addOwnLogin: (email: string, password: string, currentPassword: string) =>
		apiClient.post("/api/v1/auth/admin/register", {
			email,
			password,
			currentPassword,
		}),
	listOwnLogins: () => apiClient.get("/api/v1/auth/admin/users"),
	deleteOwnLogin: (userId: string, currentPassword: string) =>
		apiClient.delete(`/api/v1/auth/admin/users/${seg(userId)}`, {
			data: { currentPassword },
		}),

	// Push notifications
	getVapidPublicKey: () => apiClient.get("/api/v1/push/vapid-public-key"),
	subscribePush: (subscription: PushSubscriptionJSON) =>
		apiClient.post("/api/v1/push/subscribe", subscription),
	unsubscribePush: (endpoint: string) =>
		apiClient.post("/api/v1/push/unsubscribe", { endpoint }),
};

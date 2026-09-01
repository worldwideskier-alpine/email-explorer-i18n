export interface EmailExplorerOptions {
	auth?: {
		enabled?: boolean;
		registerEnabled?: boolean;
	};
	accountRecovery?: {
		fromEmail: string;
	};
}

export interface Session {
	id: string;
	userId: string;
	email: string;
	isAdmin: boolean;
	/**
	 * The person this login belongs to. Everything about what a session may
	 * reach is decided from here rather than from the login: the role, and
	 * which mailboxes. See roles.ts.
	 */
	personId?: string;
	/**
	 * Filled in by validateSession, the one place every authenticated request
	 * passes through. Absent on a session that came straight out of the
	 * Durable Object without passing through it.
	 */
	role?: import("./roles").AccountRole;
	expiresAt: number;
}

export interface User {
	id: string;
	email: string;
	isAdmin: boolean;
	createdAt: number;
	updatedAt: number;
}

export type Env = {
	MAILBOX: DurableObjectNamespace<import("./durableObject/index").MailboxDO>;
	BUCKET: R2Bucket;
	/** The deployment-wide fallback; the stored one wins. See app-settings.ts. */
	RESEND_API_KEY?: string;
	VAPID_PUBLIC_KEY: string;
	VAPID_PRIVATE_KEY: string;
	/**
	 * Optional `mailto:`/`https:` contact for whoever operates this
	 * deployment, sent to push services as the VAPID `sub` claim. Falls back
	 * to the notified mailbox's own address when unset.
	 */
	VAPID_ADMIN_CONTACT?: string;
	/**
	 * The address password-reset mail is sent from, set per deployment so a
	 * fork never has to edit source to configure it. Takes precedence over
	 * `config.accountRecovery.fromEmail`; see deployment-config.ts.
	 */
	ACCOUNT_RECOVERY_FROM?: string;
	config?: EmailExplorerOptions;
};

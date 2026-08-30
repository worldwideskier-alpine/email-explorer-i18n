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
	config?: EmailExplorerOptions;
};

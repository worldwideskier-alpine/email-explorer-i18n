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
	 * Filled in where the deployment's configuration is in scope, which the
	 * Durable Object is not -- see roles.ts. Absent on a session that came
	 * straight out of the DO without passing through validateSession.
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
	/**
	 * The login address that holds the root role. Set per deployment, and
	 * deliberately not a flag in the database -- see roles.ts for why that is
	 * the design rather than a shortcut. Unset means this deployment has no
	 * root account, which is the state every existing deployment starts in.
	 */
	ROOT_ADMIN_EMAIL?: string;
	config?: EmailExplorerOptions;
};

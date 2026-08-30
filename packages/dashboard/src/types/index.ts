export interface SignatureSettings {
	enabled: boolean;
	text: string;
	html?: string;
}

export interface SpamFilterSettings {
	claudeApiKey?: string;
	claudeApiKeyConfigured?: boolean;
}

export interface MailboxSettings {
	fromName?: string;
	/** Absent means locked, matching the server's isDeletionLocked. */
	deletionLocked?: boolean;
	forwarding?: { enabled: boolean; email: string };
	signature?: SignatureSettings;
	autoReply?: { enabled: boolean; subject: string; message: string };
	spamFilter?: SpamFilterSettings;
}

export interface Mailbox {
	id: string;
	email: string;
	name: string;
	settings?: MailboxSettings;
}

export interface Email {
	id: string;
	subject: string;
	sender: string;
	// Comma-separated address lists, the form the To:/Cc: headers use. The
	// list endpoints do not select cc and bcc, so they are absent there.
	recipient: string;
	cc?: string | null;
	bcc?: string | null;
	date: string;
	read: boolean;
	starred: boolean;
	body?: string | null;
	attachments?: Attachment[];
}

export interface Attachment {
	id: string;
	filename: string;
	mimetype: string;
	size: number;
	content_id?: string;
	disposition?: string;
}

export interface Folder {
	id: string;
	name: string;
	unreadCount: number;
}

export interface Contact {
	id: string;
	name: string;
	email: string;
}

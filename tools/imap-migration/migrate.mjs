// One-off migration script: copies mail from a Lolipop! IMAP mailbox into
// an email-explorer-ja mailbox via its admin-only import API.
//
// Usage:
//   cp .env.example .env   # then fill in real values
//   npm install
//   npm run migrate

import "dotenv/config";
import { ImapFlow } from "imapflow";

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

const config = {
	imapHost: requireEnv("LOLIPOP_IMAP_HOST"),
	imapPort: Number(process.env.LOLIPOP_IMAP_PORT || 993),
	imapSecure: (process.env.LOLIPOP_IMAP_SECURE || "true") === "true",
	imapUser: requireEnv("LOLIPOP_IMAP_USER"),
	imapPassword: requireEnv("LOLIPOP_IMAP_PASSWORD"),
	imapFolders: (process.env.LOLIPOP_IMAP_FOLDERS || "INBOX")
		.split(",")
		.map((f) => f.trim())
		.filter(Boolean),
	imapSince: process.env.LOLIPOP_IMAP_SINCE || null,

	targetBaseUrl: requireEnv("TARGET_API_BASE_URL").replace(/\/$/, ""),
	targetMailboxId: requireEnv("TARGET_MAILBOX_ID"),
	targetAdminEmail: requireEnv("TARGET_ADMIN_EMAIL"),
	targetAdminPassword: requireEnv("TARGET_ADMIN_PASSWORD"),

	dryRun: (process.env.DRY_RUN || "true") === "true",
};

// Maps common IMAP folder names to email-explorer-ja's fixed default folder
// ids. Anything unrecognized falls back to "inbox" so nothing gets lost.
const FOLDER_MAP = {
	inbox: "inbox",
	sent: "sent",
	"sent items": "sent",
	"sent messages": "sent",
	trash: "trash",
	"deleted items": "trash",
	"deleted messages": "trash",
	archive: "archive",
	spam: "spam",
	junk: "spam",
	"junk e-mail": "spam",
};

function mapFolder(imapFolderName) {
	return FOLDER_MAP[imapFolderName.trim().toLowerCase()] || "inbox";
}

async function login() {
	const res = await fetch(`${config.targetBaseUrl}/api/v1/auth/login`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			email: config.targetAdminEmail,
			password: config.targetAdminPassword,
		}),
	});
	if (!res.ok) {
		throw new Error(`Login failed: ${res.status} ${await res.text()}`);
	}
	const setCookie = res.headers.get("set-cookie");
	if (!setCookie) {
		throw new Error("Login succeeded but no session cookie was returned");
	}
	return setCookie.split(";")[0]; // "session=<id>"
}

async function ensureMailbox(cookie) {
	const res = await fetch(`${config.targetBaseUrl}/api/v1/mailboxes`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({
			email: config.targetMailboxId,
			name: config.targetMailboxId,
		}),
	});
	if (res.status === 201) {
		console.log(`Created target mailbox ${config.targetMailboxId}`);
	} else if (res.status === 409) {
		console.log(`Target mailbox ${config.targetMailboxId} already exists`);
	} else {
		throw new Error(
			`Failed to create/verify target mailbox: ${res.status} ${await res.text()}`,
		);
	}
}

async function importMessage(cookie, folder, rawSource, internalDate, flags) {
	const body = {
		folder,
		rawEmailBase64: Buffer.from(rawSource).toString("base64"),
		date: internalDate.toISOString(),
		read: flags.has("\\Seen"),
		starred: flags.has("\\Flagged"),
	};

	if (config.dryRun) {
		return { status: "dry-run" };
	}

	const res = await fetch(
		`${config.targetBaseUrl}/api/v1/admin/mailboxes/${encodeURIComponent(config.targetMailboxId)}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify(body),
		},
	);
	if (!res.ok) {
		throw new Error(`Import failed: ${res.status} ${await res.text()}`);
	}
	return res.json();
}

async function main() {
	console.log(
		config.dryRun
			? "Running in DRY RUN mode (no data will be written). Set DRY_RUN=false to actually import."
			: "Running in LIVE mode. Messages will be imported into the target mailbox.",
	);

	const cookie = config.dryRun ? null : await login();
	if (!config.dryRun) {
		await ensureMailbox(cookie);
	}

	const client = new ImapFlow({
		host: config.imapHost,
		port: config.imapPort,
		secure: config.imapSecure,
		auth: { user: config.imapUser, pass: config.imapPassword },
		logger: false,
	});

	await client.connect();

	let imported = 0;
	let failed = 0;

	try {
		for (const imapFolder of config.imapFolders) {
			const targetFolder = mapFolder(imapFolder);
			console.log(`\n=== Folder: ${imapFolder} -> ${targetFolder} ===`);

			const lock = await client.getMailboxLock(imapFolder);
			try {
				const searchCriteria = config.imapSince
					? { since: new Date(config.imapSince) }
					: true; // true = ALL messages

				for await (const message of client.fetch(searchCriteria, {
					source: true,
					internalDate: true,
					flags: true,
					envelope: true,
				})) {
					const subject = message.envelope?.subject || "(no subject)";
					try {
						await importMessage(
							cookie,
							targetFolder,
							message.source,
							message.internalDate,
							message.flags,
						);
						imported += 1;
						console.log(`  [ok] ${message.internalDate.toISOString()} ${subject}`);
					} catch (err) {
						failed += 1;
						console.error(`  [fail] ${subject}: ${err.message}`);
					}
				}
			} finally {
				lock.release();
			}
		}
	} finally {
		await client.logout();
	}

	console.log(`\nDone. Imported: ${imported}, Failed: ${failed}`);
	if (config.dryRun) {
		console.log("(dry run — nothing was actually written to the target mailbox)");
	}
}

main().catch((err) => {
	console.error("Migration failed:", err);
	process.exitCode = 1;
});

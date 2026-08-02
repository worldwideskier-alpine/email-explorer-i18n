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
// ids -- these already exist in every mailbox, so messages go straight in
// without creating a new folder.
const STANDARD_FOLDER_MAP = {
	sent: "sent",
	"sent items": "sent",
	"sent messages": "sent",
	送信済み: "sent",
	trash: "trash",
	"deleted items": "trash",
	"deleted messages": "trash",
	ゴミ箱: "trash",
	archive: "archive",
	archives: "archive",
	spam: "spam",
	junk: "spam",
	"junk e-mail": "spam",
};

// Strips the IMAP root segment ("INBOX" / "INBOX.") so nested paths like
// "INBOX.不動産賃貸.修繕" become "不動産賃貸.修繕". Returns "" for the
// root INBOX itself.
function relativeFolderName(imapPath) {
	return imapPath.replace(/^INBOX[./]?/i, "");
}

const customFolderCache = new Map();

// email-explorer-ja doesn't support nested folders, so any remaining path
// separators are flattened into a single folder name (e.g.
// "不動産賃貸.修繕" -> "不動産賃貸_修繕").
async function resolveTargetFolder(cookie, imapPath) {
	const rel = relativeFolderName(imapPath);
	if (!rel) return "inbox";

	const standard = STANDARD_FOLDER_MAP[rel.toLowerCase()];
	if (standard) return standard;

	const customName = rel.replace(/[./]/g, "_");
	return ensureCustomFolder(cookie, customName);
}

async function ensureCustomFolder(cookie, name) {
	if (customFolderCache.has(name)) return customFolderCache.get(name);

	if (config.dryRun) {
		// Don't create anything in dry-run mode -- just report the name that
		// would be used.
		customFolderCache.set(name, `(new folder) ${name}`);
		return customFolderCache.get(name);
	}

	const foldersUrl = `${config.targetBaseUrl}/api/v1/mailboxes/${encodeURIComponent(config.targetMailboxId)}/folders`;

	const createRes = await fetch(foldersUrl, {
		method: "POST",
		headers: { "Content-Type": "application/json", Cookie: cookie },
		body: JSON.stringify({ name }),
	});

	if (createRes.status === 201) {
		const folder = await createRes.json();
		console.log(`  (created folder "${name}" -> id "${folder.id}")`);
		customFolderCache.set(name, folder.id);
		return folder.id;
	}

	if (createRes.status === 409) {
		const listRes = await fetch(foldersUrl, { headers: { Cookie: cookie } });
		const folders = await listRes.json();
		const existing = folders.find((f) => f.name === name);
		if (existing) {
			customFolderCache.set(name, existing.id);
			return existing.id;
		}
	}

	throw new Error(
		`Could not create or find target folder "${name}": ${createRes.status} ${await createRes.text()}`,
	);
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
			const targetFolder = await resolveTargetFolder(cookie, imapFolder);
			console.log(`\n=== Folder: ${imapFolder} -> ${targetFolder} ===`);

			const lock = await client.getMailboxLock(imapFolder);
			try {
				// imapflow's fetch() range must be a sequence string, UID array, or
				// search object -- "1:*" is the IMAP sequence range meaning "all
				// messages in the mailbox".
				const range = config.imapSince
					? { since: new Date(config.imapSince) }
					: "1:*";

				for await (const message of client.fetch(range, {
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

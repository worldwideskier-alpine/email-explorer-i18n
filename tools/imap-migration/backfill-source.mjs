// One-off backfill script: re-fetches mail that has already been migrated
// from a Lolipop! IMAP mailbox and attaches the raw source (headers
// included) to the matching email-explorer-ja email, without touching its
// read/starred state or creating a duplicate. Any message that has no
// matching email yet is imported fresh (same as migrate.mjs), so this also
// naturally fills in anything that was missed the first time.
//
// Matching is done on the same fingerprint dedupe.mjs uses -- exact
// (subject, sender, recipient, date) -- computed the same way the server
// does (postal-mime parsing, IMAP internalDate as the date), so it lines up
// with whatever migrate.mjs originally stored.
//
// Usage:
//   cp .env.example .env   # then fill in real values
//   npm install
//   npm run backfill-source

import "dotenv/config";
import { ImapFlow } from "imapflow";
import PostalMime from "postal-mime";

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

// Same mapping migrate.mjs uses -- these folders must already exist in the
// target mailbox from the original migration, so this script never creates
// folders itself (unlike migrate.mjs). An IMAP folder that doesn't resolve
// to an existing target folder is a configuration mistake, so it fails loud.
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

function relativeFolderName(imapPath) {
	return imapPath.replace(/^INBOX[./]?/i, "");
}

function resolveTargetFolderName(imapPath) {
	const rel = relativeFolderName(imapPath);
	if (!rel) return "inbox";
	const standard = STANDARD_FOLDER_MAP[rel.toLowerCase()];
	if (standard) return standard;
	return rel.replace(/[./]/g, "_");
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
	return setCookie.split(";")[0];
}

async function resolveFolderId(cookie, name) {
	if (name === "inbox" || name === "sent" || name === "trash" || name === "archive" || name === "spam") {
		return name;
	}
	const foldersUrl = `${config.targetBaseUrl}/api/v1/mailboxes/${encodeURIComponent(config.targetMailboxId)}/folders`;
	const res = await fetch(foldersUrl, { headers: { Cookie: cookie } });
	if (!res.ok) {
		throw new Error(`Failed to list folders: ${res.status} ${await res.text()}`);
	}
	const folders = await res.json();
	const found = folders.find((f) => f.name === name);
	if (!found) {
		throw new Error(
			`Target folder "${name}" does not exist yet in ${config.targetMailboxId} -- run the original migration for this folder first.`,
		);
	}
	return found.id;
}

async function fetchAllEmails(cookie, folderId) {
	const all = [];
	let page = 1;
	const limit = 500;
	for (;;) {
		const url = `${config.targetBaseUrl}/api/v1/mailboxes/${encodeURIComponent(config.targetMailboxId)}/emails?folder=${encodeURIComponent(folderId)}&page=${page}&limit=${limit}`;
		const res = await fetch(url, { headers: { Cookie: cookie } });
		if (!res.ok) {
			throw new Error(`Failed to list emails: ${res.status} ${await res.text()}`);
		}
		const batch = await res.json();
		all.push(...batch);
		if (batch.length < limit) break;
		page += 1;
	}
	return all;
}

function fingerprint(subject, sender, recipient, date) {
	return [subject, sender, recipient, date].join(" ");
}

async function attachSource(cookie, emailId, rawSource) {
	if (config.dryRun) return;
	const res = await fetch(
		`${config.targetBaseUrl}/api/v1/mailboxes/${encodeURIComponent(config.targetMailboxId)}/emails/${emailId}/source`,
		{
			method: "PUT",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({
				rawEmailBase64: Buffer.from(rawSource).toString("base64"),
			}),
		},
	);
	if (!res.ok) {
		throw new Error(`Attach source failed: ${res.status} ${await res.text()}`);
	}
}

async function importNew(cookie, folderId, rawSource, internalDate, flags) {
	if (config.dryRun) return;
	const res = await fetch(
		`${config.targetBaseUrl}/api/v1/admin/mailboxes/${encodeURIComponent(config.targetMailboxId)}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json", Cookie: cookie },
			body: JSON.stringify({
				folder: folderId,
				rawEmailBase64: Buffer.from(rawSource).toString("base64"),
				date: internalDate.toISOString(),
				read: flags.has("\\Seen"),
				starred: flags.has("\\Flagged"),
			}),
		},
	);
	if (!res.ok) {
		throw new Error(`Import failed: ${res.status} ${await res.text()}`);
	}
}

async function main() {
	console.log(
		config.dryRun
			? "Running in DRY RUN mode (no data will be written). Set DRY_RUN=false to actually write."
			: "Running in LIVE mode. Raw sources will be attached / missing messages imported.",
	);

	const cookie = config.dryRun ? null : await login();

	const client = new ImapFlow({
		host: config.imapHost,
		port: config.imapPort,
		secure: config.imapSecure,
		auth: { user: config.imapUser, pass: config.imapPassword },
		logger: false,
	});

	await client.connect();

	let attached = 0;
	let importedNew = 0;
	let ambiguous = 0;
	let failed = 0;

	try {
		for (const imapFolder of config.imapFolders) {
			const targetFolderName = resolveTargetFolderName(imapFolder);
			const targetFolderId = config.dryRun
				? targetFolderName
				: await resolveFolderId(cookie, targetFolderName);
			console.log(`\n=== Folder: ${imapFolder} -> ${targetFolderName} (${targetFolderId}) ===`);

			const existing = config.dryRun ? [] : await fetchAllEmails(cookie, targetFolderId);
			const byFingerprint = new Map();
			for (const email of existing) {
				const key = fingerprint(email.subject, email.sender, email.recipient, email.date);
				if (!byFingerprint.has(key)) byFingerprint.set(key, []);
				byFingerprint.get(key).push(email.id);
			}
			console.log(`  Found ${existing.length} already-imported email(s) in this folder.`);

			const lock = await client.getMailboxLock(imapFolder);
			try {
				const range = config.imapSince ? { since: new Date(config.imapSince) } : "1:*";

				for await (const message of client.fetch(range, {
					source: true,
					internalDate: true,
					flags: true,
				})) {
					let parsed;
					try {
						parsed = await PostalMime.parse(message.source);
					} catch (err) {
						failed += 1;
						console.error(`  [fail] could not parse message: ${err.message}`);
						continue;
					}

					const subject = parsed.subject || "";
					const sender = parsed.from?.address || "";
					const recipient = parsed.to?.[0]?.address || config.targetMailboxId;
					const date = message.internalDate.toISOString();
					const key = fingerprint(subject, sender, recipient, date);
					const matches = byFingerprint.get(key) || [];

					try {
						if (matches.length === 1) {
							await attachSource(cookie, matches[0], message.source);
							attached += 1;
							console.log(`  [attached] ${date} ${subject} -> ${matches[0]}`);
						} else if (matches.length === 0) {
							await importNew(cookie, targetFolderId, message.source, message.internalDate, message.flags);
							importedNew += 1;
							console.log(`  [imported new] ${date} ${subject}`);
						} else {
							ambiguous += 1;
							console.log(
								`  [needs manual review] ${date} ${subject} matches ${matches.length} existing emails: ${matches.join(", ")}`,
							);
						}
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

	console.log(
		`\nDone. Attached: ${attached}, Imported new: ${importedNew}, Needs manual review: ${ambiguous}, Failed: ${failed}`,
	);
	if (config.dryRun) {
		console.log("(dry run — nothing was actually written to the target mailbox)");
	}
}

main().catch((err) => {
	console.error("Backfill failed:", err);
	process.exitCode = 1;
});

// Lists all IMAP folders on the source mailbox (e.g. Lolipop) without
// importing anything, so you can see whether custom folders exist before
// deciding what to pass as LOLIPOP_IMAP_FOLDERS.
import "dotenv/config";
import { ImapFlow } from "imapflow";

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

const client = new ImapFlow({
	host: requireEnv("LOLIPOP_IMAP_HOST"),
	port: Number(process.env.LOLIPOP_IMAP_PORT || 993),
	secure: (process.env.LOLIPOP_IMAP_SECURE || "true") === "true",
	auth: {
		user: requireEnv("LOLIPOP_IMAP_USER"),
		pass: requireEnv("LOLIPOP_IMAP_PASSWORD"),
	},
	logger: false,
});

await client.connect();

try {
	const mailboxes = await client.list({ statusQuery: { messages: true } });
	console.log(`\nFolders found for ${process.env.LOLIPOP_IMAP_USER}:\n`);
	for (const mbox of mailboxes) {
		const count = mbox.status?.messages ?? "?";
		console.log(`  ${mbox.path}  (${count} messages)`);
	}
	console.log(
		"\nTo import a folder, add its exact name above to LOLIPOP_IMAP_FOLDERS (comma-separated).",
	);
} finally {
	await client.logout();
}

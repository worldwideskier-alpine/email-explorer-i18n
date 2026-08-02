// Lists the folders (and their ids) that currently exist in an
// email-explorer-ja mailbox. Useful for finding a custom folder's id before
// running dedupe.mjs against it, since dedupe filters by folder id, not name.
import "dotenv/config";

function requireEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

const config = {
	targetBaseUrl: requireEnv("TARGET_API_BASE_URL").replace(/\/$/, ""),
	targetMailboxId: requireEnv("TARGET_MAILBOX_ID"),
	targetAdminEmail: requireEnv("TARGET_ADMIN_EMAIL"),
	targetAdminPassword: requireEnv("TARGET_ADMIN_PASSWORD"),
};

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

async function main() {
	const cookie = await login();
	const res = await fetch(
		`${config.targetBaseUrl}/api/v1/mailboxes/${encodeURIComponent(config.targetMailboxId)}/folders`,
		{ headers: { Cookie: cookie } },
	);
	if (!res.ok) {
		throw new Error(`Failed to list folders: ${res.status} ${await res.text()}`);
	}
	const folders = await res.json();
	for (const folder of folders) {
		console.log(`${folder.id}\t${folder.name}`);
	}
}

main().catch((err) => {
	console.error("Listing target folders failed:", err);
	process.exitCode = 1;
});

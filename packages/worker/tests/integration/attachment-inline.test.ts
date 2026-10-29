import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createDummyMailbox,
	mailboxId,
	sessionToken,
	testAuthBeforeAll,
} from "./utils";

/**
 * A PDF or a picture is served to be shown in the browser, in a tab of its
 * own; anything else is still a download. Shown inline, an attachment is the
 * sender's file at this dashboard's origin, and an HTML or SVG file shown that
 * way ran its script and read the dashboard's session (measured in Chromium),
 * so which types are shown is the whole of the matter. See
 * attachment-inline.ts.
 */

const API = "http://local.test/api/v1";
const box = `${API}/mailboxes/${encodeURIComponent(mailboxId)}`;

const FILES: [string, string, boolean][] = [
	["plan.pdf", "application/pdf", true],
	["photo.jpg", "image/jpeg", true],
	["shot.png", "image/png", true],
	["old.jpg", "image/jpg", true],
	["files.zip", "application/zip", false],
	["drawing.svg", "image/svg+xml", false],
	["page.html", "text/html", false],
	// A PDF by name only: the name is the sender's, the type is what counts.
	["named.pdf", "application/octet-stream", false],
	["notes.txt", "text/plain", false],
];

function message(): string {
	const parts = FILES.map(([name, type]) =>
		[
			"--b",
			`Content-Type: ${type}; name="${name}"`,
			`Content-Disposition: attachment; filename="${name}"`,
			"Content-Transfer-Encoding: base64",
			"",
			btoa(`<html><script>alert(1)</script>${name}</html>`),
		].join("\r\n"),
	);
	return [
		"From: a@example.org",
		"Subject: files",
		"MIME-Version: 1.0",
		'Content-Type: multipart/mixed; boundary="b"',
		"",
		"--b",
		"Content-Type: text/plain",
		"",
		"see attached",
		...parts,
		"--b--",
		"",
	].join("\r\n");
}

interface Listed {
	id: string;
	filename: string;
	opensInline: boolean;
}

async function received(): Promise<{ id: string; attachments: Listed[] }> {
	const res = await authenticatedFetch(
		`${API}/admin/mailboxes/${encodeURIComponent(mailboxId)}/import`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				folder: "inbox",
				rawEmailBase64: btoa(message()),
			}),
		},
	);
	expect(res.status).toBe(201);
	const { id } = await res.json<{ id: string }>();
	const email = await (await authenticatedFetch(`${box}/emails/${id}`)).json<{
		attachments: Listed[];
	}>();
	return { id, attachments: email.attachments };
}

describe("an attachment opened in a tab of its own", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createDummyMailbox();
	});

	it("is a PDF or a picture, and everything else is a download", async () => {
		const { id, attachments } = await received();
		expect(attachments).toHaveLength(FILES.length);
		for (const [name, , shown] of FILES) {
			const listed = attachments.find((a) => a.filename === name);
			expect(listed?.opensInline, name).toBe(shown);
			const res = await authenticatedFetch(
				`${box}/emails/${id}/attachments/${listed?.id}`,
			);
			expect(res.status, name).toBe(200);
			const disposition = res.headers.get("Content-Disposition") ?? "";
			expect(disposition.split(";")[0], name).toBe(
				shown ? "inline" : "attachment",
			);
			// Its name goes with it either way, for "save as".
			expect(disposition, name).toContain(`filename="${name}"`);
			// And its bytes are never read as anything but the type it has.
			expect(res.headers.get("X-Content-Type-Options"), name).toBe("nosniff");
		}
	});

	it("is reached by the tab itself, with the session cookie alone", async () => {
		const { id, attachments } = await received();
		const pdf = attachments.find((a) => a.filename === "plan.pdf");
		// A new tab is a navigation: no bearer token, only the cookie.
		const res = await SELF.fetch(`${box}/emails/${id}/attachments/${pdf?.id}`, {
			headers: {
				Cookie: `session=${sessionToken}`,
				"Sec-Fetch-Dest": "document",
			},
		});
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toBe("application/pdf");
		expect(res.headers.get("Content-Disposition")).toMatch(/^inline;/);
	});
});

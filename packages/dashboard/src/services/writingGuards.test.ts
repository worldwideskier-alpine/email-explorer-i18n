import type { AxiosAdapter } from "axios";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import api, { apiClient, leave } from "./api";
import { holdReload, somethingIsBeingWritten } from "./appUpdate";

/**
 * What must not be thrown away: a message being written, a restore under
 * way. And what must not go into a path as it came.
 */

const seen: string[] = [];
let status = 200;
const answer: AxiosAdapter = async (config) => {
	seen.push(config.url ?? "");
	const response = {
		data: {},
		status,
		statusText: "",
		headers: {},
		config,
	};
	if (status >= 400) {
		throw Object.assign(new Error(`status ${status}`), {
			response,
			config,
			isAxiosError: true,
		});
	}
	return response;
};

beforeEach(() => {
	seen.length = 0;
	status = 200;
	apiClient.defaults.adapter = answer;
	document.body.innerHTML = "";
});

afterEach(() => {
	document.body.innerHTML = "";
});

describe("a path segment", () => {
	/** An attachment name is the sender's to choose; "/" in one named another path. */
	it("goes into the path encoded", async () => {
		await api.getMailbox("a@example.com");
		await api.downloadBackup?.("m@example.com", "../../x?y#z");
		await api.getEmail("m@example.com", "id/../other");

		expect(seen).toContain("/api/v1/mailboxes/a%40example.com");
		expect(seen).toContain(
			"/api/v1/mailboxes/m%40example.com/emails/id%2F..%2Fother",
		);
		expect(seen.some((url) => url.includes("../"))).toBe(false);
	});
});

describe("whether something is being written", () => {
	const field = (html: string) => {
		document.body.innerHTML = html;
		return document.body.firstElementChild as HTMLInputElement;
	};

	/** The composer's To and Subject are inputs, not textareas. */
	it("counts a filled box", () => {
		field('<input type="text" value="Subject line">');
		expect(somethingIsBeingWritten(document)).toBe(true);
	});

	it("does not count a box nobody can type into", () => {
		field('<input type="email" value="shown@example.com" disabled>');
		expect(somethingIsBeingWritten(document)).toBe(false);
	});

	it("counts a picked attachment", () => {
		const input = field('<input type="file">');
		Object.defineProperty(input, "files", {
			value: [new File(["x"], "a.txt")],
		});
		expect(somethingIsBeingWritten(document)).toBe(true);
	});

	/** A restore shows in no field, and a reload cut it off halfway. */
	it("counts work held open until it is released", () => {
		const release = holdReload();
		expect(somethingIsBeingWritten(document)).toBe(true);
		release();
		release();
		expect(somethingIsBeingWritten(document)).toBe(false);
	});
});

describe("a session that has ended", () => {
	const went: string[] = [];
	beforeEach(() => {
		went.length = 0;
		leave.to = (url: string) => {
			went.push(url);
		};
		window.history.replaceState(
			null,
			"",
			"/mailbox/m%40example.com/emails/inbox",
		);
	});

	/**
	 * The 401 used to send the page to /login at once, and the unsent
	 * message went with it.
	 */
	it("does not take the page away from somebody writing", async () => {
		document.body.innerHTML = "<textarea>half a message</textarea>";
		status = 401;
		await api.listEmails("m@example.com", {}).catch(() => {});
		expect(went).toEqual([]);
	});

	it("goes to sign in, and back here after, when nothing is being written", async () => {
		status = 401;
		await api.listEmails("m@example.com", {}).catch(() => {});
		expect(went).toEqual([
			`/login?redirect=${encodeURIComponent("/mailbox/m%40example.com/emails/inbox")}`,
		]);
	});
});

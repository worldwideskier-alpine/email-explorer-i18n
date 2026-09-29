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

	/**
	 * The header's search box keeps its query after the search has run.
	 * Counted, it held on every screen with the header: a session that ended
	 * there never reached sign-in, and a new build was never picked up.
	 */
	/**
	 * The browser fills a current-password box itself, on /account and
	 * /admin, and again after every reload: counted, a tab left on either
	 * never picked up a new build.
	 */
	it("does not count a filled password box that is not being typed into", () => {
		field(
			'<input type="password" autocomplete="current-password" value="filled-by-the-browser">',
		);
		expect(somethingIsBeingWritten(document)).toBe(false);
	});

	it("does not count a box marked as not being writing", () => {
		const box = field('<input type="text" value="invoice" data-not-writing>');
		expect(somethingIsBeingWritten(document)).toBe(false);
		box.focus();
		expect(somethingIsBeingWritten(document)).toBe(false);
	});

	it("is told so by the header's search box", () => {
		const header = Object.values(
			import.meta.glob("../components/Header.vue", {
				query: "?raw",
				import: "default",
				eager: true,
			}) as Record<string, string>,
		)[0];
		const box = header.slice(
			header.indexOf("<input"),
			header.indexOf("/>", header.indexOf("<input")),
		);
		expect(box).toContain('v-model="searchQuery"');
		expect(box).toContain("data-not-writing");
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

	/**
	 * Only the stored copy used to go. The router asks the one in memory, so
	 * every navigation after went through while every request was refused --
	 * "the next navigation goes to sign-in" was not so.
	 */
	it("is forgotten in memory too, so the next navigation goes to sign in", async () => {
		const { whenSessionEnds } = await import("./sessionEnd");
		let forgotten = 0;
		whenSessionEnds(() => {
			forgotten += 1;
		});
		document.body.innerHTML = "<textarea>half a message</textarea>";
		status = 401;
		await api.listEmails("m@example.com", {}).catch(() => {});
		expect(went).toEqual([]);
		expect(forgotten).toBe(1);
	});

	it("goes to sign in, and back here after, when nothing is being written", async () => {
		status = 401;
		await api.listEmails("m@example.com", {}).catch(() => {});
		expect(went).toEqual([
			`/login?redirect=${encodeURIComponent("/mailbox/m%40example.com/emails/inbox")}`,
		]);
	});
});

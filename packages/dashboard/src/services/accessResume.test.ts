import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkOnce, reloading } from "./appUpdate";

/**
 * Coming back through Cloudflare Access.
 *
 * Access signs a browser in for a while, and when that runs out it answers
 * every request with a redirect to its sign-in. A request from script cannot
 * follow it there -- measured in Chromium, the dashboard's own requests end
 * as a network error with no answer, and the session is kept -- so an
 * installed app resumed after the lapse failed every request, said nothing,
 * and a phone whose notifications had stopped stayed that way. The check the
 * app already makes when it comes back to the front now asks for the page
 * without following a redirect, and a redirect there is a reload, which is a
 * navigation and can go through.
 */

const BUILD = "/assets/index-AAA111.js";
const PAGE = `<!doctype html><script type="module" src="${BUILD}"></script>`;

/** Each test's "now", far enough apart for the once-a-minute quiet period. */
let now = Date.UTC(2026, 9, 16, 9, 0, 0);
const later = (ms: number) => {
	now += ms;
};

const reload = vi.fn();

/** A server answering `/` (and `/index.html`) as told. */
function serving(answers: Record<string, "page" | "redirect">) {
	const fetch = vi.fn(async (url: string, _init?: RequestInit) => {
		const answer = answers[url];
		if (answer === "redirect") {
			return {
				type: "opaqueredirect",
				ok: false,
				status: 0,
				text: async () => "",
			};
		}
		if (answer === "page") {
			return { type: "basic", ok: true, status: 200, text: async () => PAGE };
		}
		return { type: "basic", ok: false, status: 404, text: async () => "" };
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

beforeEach(() => {
	// Past the previous test's quiet period, and an hour past its reloads.
	later(2 * 60 * 60 * 1000);
	vi.spyOn(Date, "now").mockImplementation(() => now);
	vi.spyOn(reloading, "now").mockImplementation(reload);
	reload.mockClear();
	localStorage.clear();
	document.head.innerHTML = `<script type="module" src="${BUILD}"></script>`;
	document.body.innerHTML = "";
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("a redirect where the page should be", () => {
	it("reloads, to go through it", async () => {
		const fetch = serving({ "/": "redirect" });
		await checkOnce();
		expect(reload).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith("/", {
			cache: "no-store",
			redirect: "manual",
		});
	});

	/** A sign-in an installed app cannot finish must not become a loop. */
	it("reloads twice an hour at most", async () => {
		serving({ "/": "redirect" });
		await checkOnce();
		later(61_000);
		await checkOnce();
		later(61_000);
		await checkOnce();
		expect(reload).toHaveBeenCalledTimes(2);

		later(60 * 60 * 1000);
		await checkOnce();
		expect(reload).toHaveBeenCalledTimes(3);
	});

	it("does not reload when the count cannot be kept", async () => {
		serving({ "/": "redirect" });
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("storage refused");
		});
		await checkOnce();
		expect(reload).not.toHaveBeenCalled();
	});

	it("does not reload when the count cannot be written", async () => {
		serving({ "/": "redirect" });
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("storage full");
		});
		await checkOnce();
		expect(reload).not.toHaveBeenCalled();
	});

	it("does not reload over somebody's writing", async () => {
		serving({ "/": "redirect" });
		document.body.innerHTML = "<textarea>half a reply</textarea>";
		await checkOnce();
		expect(reload).not.toHaveBeenCalled();
		// And it was not counted against the next time.
		document.body.innerHTML = "";
		later(61_000);
		await checkOnce();
		later(61_000);
		await checkOnce();
		expect(reload).toHaveBeenCalledTimes(2);
	});
});

/**
 * `/index.html` answers with a redirect to `/` under this deployment's asset
 * settings (measured with wrangler and auto-trailing-slash). Asked for, it
 * would read as "something in front wants a sign-in" on every resume.
 */
describe("the page it asks for", () => {
	it("is `/`, so the asset redirect is never taken for a sign-in", async () => {
		serving({ "/index.html": "redirect", "/": "page" });
		await checkOnce();
		expect(reload).not.toHaveBeenCalled();
	});

	it("still reloads into a new build", async () => {
		const fetch = vi.fn(async () => ({
			type: "basic",
			ok: true,
			status: 200,
			text: async () =>
				`<!doctype html><script type="module" src="/assets/index-ZZZ999.js"></script>`,
		}));
		vi.stubGlobal("fetch", fetch);
		await checkOnce();
		expect(reload).toHaveBeenCalledTimes(1);
	});
});

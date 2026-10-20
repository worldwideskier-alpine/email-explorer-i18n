import { afterEach, describe, expect, it, vi } from "vitest";
import { toldToOpenTheApp } from "./push";

/**
 * Whether an "open the app" notification is showing: what a tab coming to
 * the front asks before it hands its subscription over again
 * (notificationTap.ts). It asks the browser alone, so switching back to the
 * app costs no request -- unless it answers yes for anything else, and then
 * every switch sent two. Its caller's test stands it in, so it is asked here.
 */

function browserShowing(shown: { tag: string }[] | "no worker" | "fails") {
	vi.stubGlobal("Notification", { permission: "granted" });
	vi.stubGlobal("PushManager", function PushManager() {});
	Object.defineProperty(navigator, "serviceWorker", {
		configurable: true,
		value: {
			getRegistration: async () => {
				if (shown === "fails") throw new Error("InvalidStateError");
				if (shown === "no worker") return undefined;
				return {
					getNotifications: async (filter?: { tag?: string }) =>
						shown.filter((n) => !filter?.tag || n.tag === filter.tag),
				};
			},
		},
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("an 'open the app' notification showing", () => {
	it("is seen among the others", async () => {
		browserShowing([{ tag: "message-1" }, { tag: "open-app" }]);
		expect(await toldToOpenTheApp()).toBe(true);
	});

	it("is not a message's notification", async () => {
		browserShowing([{ tag: "message-1" }, { tag: "message-2" }]);
		expect(await toldToOpenTheApp()).toBe(false);
	});

	it("is not seen where no service worker is registered, or one fails to answer", async () => {
		browserShowing("no worker");
		expect(await toldToOpenTheApp()).toBe(false);
		browserShowing("fails");
		expect(await toldToOpenTheApp()).toBe(false);
	});
});

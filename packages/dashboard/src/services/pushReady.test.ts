import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A service worker that never starts.
 *
 * `navigator.serviceWorker.ready` never settles when no worker is registered
 * -- refused by the browser, a private window, a build without sw.js -- and
 * the settings screen's notification switch waited on it for ever, spinning.
 */

vi.mock("./api", () => ({
	default: {
		getVapidPublicKey: vi.fn(async () => ({ data: { publicKey: "AAAA" } })),
		subscribePush: vi.fn(),
	},
}));

const { getExistingSubscription, subscribeToPush } = await import("./push");

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("PushManager", class {});
	vi.stubGlobal("Notification", {
		permission: "granted",
		requestPermission: async () => "granted",
	});
	Object.defineProperty(navigator, "serviceWorker", {
		configurable: true,
		value: { ready: new Promise(() => {}) },
	});
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("with no service worker", () => {
	it("there is no subscription, said within seconds", async () => {
		const asked = getExistingSubscription();
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(asked).resolves.toBeNull();
	});

	it("subscribing fails, rather than waiting for ever", async () => {
		const asked = subscribeToPush();
		const settled = expect(asked).rejects.toThrow("did not start");
		await vi.advanceTimersByTimeAsync(10_000);
		await settled;
	});
});

import { buildPushHTTPRequest } from "@pushforge/builder";
import { describe, expect, it } from "vitest";
// Plain JS on purpose: it runs under node from the deploy workflow.
import { withheld } from "../../scripts/log-redaction.mjs";
import {
	generatePushKey,
	needsPushKey,
	PUSH_KEY_SECRET,
} from "../../scripts/push-key.mjs";
import { publicKeyOf } from "../../src/routes/push";

/**
 * The deploy's push key (scripts/push-key.mjs): it asks the Worker's secret
 * list whether there is one, and makes one only when the list plainly says
 * there is not. A key put over an existing one stops every device subscribed
 * under it without a word, so every answer this cannot read is "leave it".
 *
 * The step itself runs only on GitHub; workflowGuards.test.ts holds its
 * shape, and this holds what it decides and what it makes.
 */

/** What `wrangler secret list --format json` prints: JSON.stringify(list, null, "  "). */
const listed = (names: string[]) =>
	`${JSON.stringify(
		names.map((name) => ({ name, type: "secret_text" })),
		null,
		"  ",
	)}\n`;

/** Printed to stdout ahead of everything on a runner's first wrangler run. */
const TELEMETRY =
	"\nCloudflare collects anonymous telemetry about your usage of Wrangler. Learn more at https://github.com/cloudflare/workers-sdk/tree/main/packages/wrangler/telemetry.md\n";

/** As the deploy step reads it: stderr folded in, through withhold.mjs. */
const throughTheFilter = (output: string) =>
	output
		.split("\n")
		.map((line) => withheld(line))
		.join("\n");

describe("whether the Worker needs a push key", () => {
	it("makes one only when the list was read and the key is not in it", () => {
		expect(needsPushKey("[]\n")).toBe("generate");
		expect(needsPushKey(`${TELEMETRY}[]\n`)).toBe("generate");
		expect(needsPushKey(TELEMETRY + listed(["ACCOUNT_RECOVERY_FROM"]))).toBe(
			"generate",
		);
		expect(needsPushKey(throughTheFilter(TELEMETRY + listed(["OTHER"])))).toBe(
			"generate",
		);
	});

	it("leaves a key that is there", () => {
		expect(needsPushKey(listed([PUSH_KEY_SECRET]))).toBe("present");
		expect(
			needsPushKey(
				throughTheFilter(
					TELEMETRY + listed(["ACCOUNT_RECOVERY_FROM", PUSH_KEY_SECRET]),
				),
			),
		).toBe("present");
		// A warning around the list does not hide the key.
		expect(
			needsPushKey(
				`▲ [WARNING] something wrangler wanted to say\n${listed([PUSH_KEY_SECRET])}`,
			),
		).toBe("present");
	});

	it("leaves the key alone whenever the list cannot be read", () => {
		const unreadable = [
			"",
			"✘ [ERROR] A request to the Cloudflare API failed. Authentication error [code: 10000]\n",
			'✘ [ERROR] Worker "a-worker" not found.\n',
			// Cut off partway.
			listed([PUSH_KEY_SECRET]).slice(0, 30),
			// A list of something that is not secrets.
			"[\n  1\n]\n",
			'[\n  {\n    "type": "secret_text"\n  }\n]\n',
			"[\n  null\n]\n",
			// Not a list.
			'{\n  "name": "OTHER"\n}\n',
			// Two lists: which one is the answer is a guess, and a guess
			// could be the empty one in front of the key.
			`[]\n${listed([PUSH_KEY_SECRET])}`,
		];
		for (const output of unreadable) {
			expect(needsPushKey(output), JSON.stringify(output)).toBe("unreadable");
		}
	});
});

/** base64url, as a push subscription and a JWT carry their bytes. */
const b64url = (bytes: ArrayBuffer | Uint8Array) =>
	btoa(String.fromCharCode(...new Uint8Array(bytes)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
const fromB64url = (text: string) =>
	Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
		ch.charCodeAt(0),
	);

describe("a new push key", () => {
	it("is a whole P-256 key the Worker can read its public half from", async () => {
		const key = await generatePushKey();
		expect(key.kty).toBe("EC");
		expect(key.crv).toBe("P-256");
		expect(key.alg).toBe("ES256");
		for (const part of ["x", "y", "d"] as const) {
			expect(key[part], part).toMatch(/^[A-Za-z0-9_-]{43}$/);
		}
		// What the Worker hands browsers: the uncompressed point, 65 bytes.
		const served = publicKeyOf(JSON.stringify(key));
		expect(served).toHaveLength(87);
		expect(served?.startsWith("B")).toBe(true);
		// One line, so nothing of it is lost to the trailing whitespace
		// `wrangler secret put` trims from its stdin.
		expect(JSON.stringify(key)).not.toMatch(/\s/);
	});

	it("is a new one every time", async () => {
		const [one, two] = await Promise.all([
			generatePushKey(),
			generatePushKey(),
		]);
		expect(one.d).not.toBe(two.d);
		expect(one.x).not.toBe(two.x);
	});

	/**
	 * What a push service checks: the `k=` the push carries is the key the
	 * browser subscribed with -- which is what the Worker served it -- and the
	 * `t=` token is signed by its pair. Built with the library the Worker
	 * sends with, from the key as the Worker reads it (a JSON string), and
	 * sent nowhere.
	 */
	it("signs a push the way the Worker sends one, under the key it serves", async () => {
		const key = JSON.parse(JSON.stringify(await generatePushKey()));
		const browser = (await crypto.subtle.generateKey(
			{ name: "ECDH", namedCurve: "P-256" },
			true,
			["deriveBits"],
		)) as CryptoKeyPair;
		const p256dh = b64url(
			(await crypto.subtle.exportKey("raw", browser.publicKey)) as ArrayBuffer,
		);
		const { headers } = await buildPushHTTPRequest({
			privateJWK: key,
			subscription: {
				endpoint: "https://push.example.test/device",
				keys: {
					p256dh,
					auth: b64url(crypto.getRandomValues(new Uint8Array(16))),
				},
			},
			message: {
				payload: { title: "a push" },
				adminContact: "mailto:nobody@example.test",
				options: { ttl: 60 },
			},
		});
		const authorization =
			headers instanceof Headers
				? (headers.get("Authorization") ?? "")
				: (headers.Authorization ?? "");
		const k = /k=([A-Za-z0-9_-]+)/.exec(authorization)?.[1];
		const t = /t=([A-Za-z0-9_.-]+)/.exec(authorization)?.[1] ?? "";
		expect(k).toBe(publicKeyOf(JSON.stringify(key)));

		const [header, claims, signature] = t.split(".");
		expect(
			JSON.parse(new TextDecoder().decode(fromB64url(header ?? ""))),
		).toMatchObject({
			alg: "ES256",
		});
		const verifier = await crypto.subtle.importKey(
			"raw",
			fromB64url(k ?? ""),
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["verify"],
		);
		expect(
			await crypto.subtle.verify(
				{ name: "ECDSA", hash: "SHA-256" },
				verifier,
				fromB64url(signature ?? ""),
				new TextEncoder().encode(`${header}.${claims}`),
			),
		).toBe(true);
	});
});

import { expect } from "vitest";

/**
 * Reading a push the way a browser does.
 *
 * The recording push service in vitest.config.mts keeps what it is sent, and
 * a test holding the subscription's private key decrypts it -- so a test can
 * say what a notification said, not only that one was sent.
 */

export const PUSH_ORIGIN = "https://push-record.example.test";

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

function base64Decode(text: string): Uint8Array {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
}

const concat = (...parts: Uint8Array[]) => {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
};

const utf8 = (text: string) => new TextEncoder().encode(text);

/** A browser's side of a subscription: its key pair and auth secret. */
export async function browserSubscription() {
	const keyPair = (await crypto.subtle.generateKey(
		{ name: "ECDH", namedCurve: "P-256" },
		true,
		["deriveBits"],
	)) as CryptoKeyPair;
	const publicKey = new Uint8Array(
		(await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer,
	);
	const authSecret = crypto.getRandomValues(new Uint8Array(16));
	return {
		privateKey: keyPair.privateKey,
		publicKey,
		authSecret,
		keys: {
			p256dh: base64UrlEncode(publicKey),
			auth: base64UrlEncode(authSecret),
		},
	};
}

export type Browser = Awaited<ReturnType<typeof browserSubscription>>;

async function hkdf(
	salt: Uint8Array,
	ikm: Uint8Array | CryptoKey,
	info: Uint8Array,
	bits: number,
): Promise<Uint8Array> {
	const key =
		ikm instanceof Uint8Array
			? await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"])
			: ikm;
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt, info },
			key,
			bits,
		),
	);
}

/**
 * The `aesgcm` content encoding the push library sends (draft-ietf-webpush-
 * encryption-04): salt and sender key in headers, a two-byte padding length
 * before the plaintext.
 */
async function decrypt(
	browser: Browser,
	push: { body: string; encryption: string | null; cryptoKey: string | null },
): Promise<Record<string, string>> {
	const salt = base64Decode(
		/salt=([^;,]+)/.exec(push.encryption ?? "")?.[1] ?? "",
	);
	const senderKey = base64Decode(
		/dh=([^;,]+)/.exec(push.cryptoKey ?? "")?.[1] ?? "",
	);
	expect([salt.length, senderKey.length]).toEqual([16, 65]);
	const sender = await crypto.subtle.importKey(
		"raw",
		senderKey,
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits(
			// `public`, as WebCrypto names it; the workers types spell the
			// field `$public`, which the runtime does not read.
			{
				name: "ECDH",
				public: sender,
			} as unknown as SubtleCryptoDeriveKeyAlgorithm,
			browser.privateKey,
			256,
		),
	);
	const prk = await hkdf(
		browser.authSecret,
		shared,
		utf8("Content-Encoding: auth\0"),
		256,
	);
	const context = concat(
		utf8("P-256\0"),
		new Uint8Array([0, browser.publicKey.length]),
		browser.publicKey,
		new Uint8Array([0, senderKey.length]),
		senderKey,
	);
	const nonce = await hkdf(
		salt,
		prk,
		concat(utf8("Content-Encoding: nonce\0"), context),
		96,
	);
	const cek = await crypto.subtle.importKey(
		"raw",
		await hkdf(
			salt,
			prk,
			concat(utf8("Content-Encoding: aesgcm\0"), context),
			128,
		),
		"AES-GCM",
		false,
		["decrypt"],
	);
	const padded = new Uint8Array(
		await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: nonce },
			cek,
			base64Decode(push.body),
		),
	);
	const padding = (padded[0] << 8) | padded[1];
	return JSON.parse(new TextDecoder().decode(padded.slice(2 + padding)));
}

/** What arrived at one path, decrypted. */
export async function received(
	browser: Browser,
	path: string,
	host = new URL(PUSH_ORIGIN).hostname,
) {
	const all = await (await fetch(`${PUSH_ORIGIN}/__received`)).json<
		{
			host: string;
			path: string;
			body: string;
			encryption: string | null;
			cryptoKey: string | null;
		}[]
	>();
	return Promise.all(
		all
			.filter((p) => p.host === host && p.path === path)
			.map((p) => decrypt(browser, p)),
	);
}

/** How many pushes arrived at one path, whatever they said. */
export async function arrivedAt(
	path: string,
	host = new URL(PUSH_ORIGIN).hostname,
): Promise<number> {
	const all = await (await fetch(`https://${host}/__received`)).json<
		{ host: string; path: string }[]
	>();
	return all.filter((p) => p.host === host && p.path === path).length;
}

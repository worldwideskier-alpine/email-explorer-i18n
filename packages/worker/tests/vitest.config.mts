import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			singleWorker: true,
			wrangler: {
				// Resolved from this file rather than left relative. The pool used
				// to resolve a relative configPath against the directory holding
				// this config; as a Vite plugin it resolves against the project
				// root instead, so "../dev/..." silently pointed one level too
				// high and every test failed to start.
				configPath: fileURLToPath(
					new URL("../dev/wrangler.jsonc", import.meta.url),
				),
			},
			miniflare: {
				// VAPID_PRIVATE_KEY normally comes from the gitignored dev/.dev.vars
				// file, which doesn't exist in a fresh CI checkout. Push-notification
				// tests need a real (test-only, not production) key so
				// notifyMailboxSubscribers doesn't silently no-op.
				bindings: {
					VAPID_PRIVATE_KEY:
						'{"kty":"EC","x":"8E1Zw4MOMOZ7rj054pNEfyPiDPFFa8fslXToOdkZ7T8","y":"a6S25MrJI_qeBANimu06z3PpRZ9qt4f7TV-vzugFLNo","crv":"P-256","d":"jttxgnEcVnL_dzqyTnUWQWViXHLM_owkiFnF5EHKung","alg":"ES256","key_ops":["sign"],"ext":true}',
					// Sending now refuses to run with no key at all rather than
					// putting "Bearer undefined" on the wire, which is what
					// these tests used to do against the stub below. A
					// placeholder keeps every send path testable;
					// resend-settings.test.ts passes its own env objects to
					// check which of the two sources wins.
					RESEND_API_KEY: "re_placeholder_for_tests",
				},
				r2Persist: false,
				compatibilityFlags: ["nodejs_compat", "nodejs_als"],
				serviceBindings: {
					async SEND_EMAIL() {
						return {};
					},
				},
				// Reply/forward routes call the real Resend API over fetch();
				// stub it out so integration tests don't need network access
				// or a real API key.
				outboundService: async (request) => {
					const url = new URL(request.url);
					if (url.hostname === "api.resend.com") {
						const body = await request.clone().text();
						// Nothing downstream keeps the request we sent to Resend --
						// sendEmail discards the response on success -- so a test that
						// needs to assert on the recipients puts this marker in the
						// subject and reads them back out of the failure message.
						if (body.includes("ECHO_RESEND_REQUEST")) {
							return new Response(body, { status: 500 });
						}
						return new Response(JSON.stringify({ id: "mock-resend-id" }), {
							status: 200,
							headers: { "content-type": "application/json" },
						});
					}
					// Web Push sends to whatever endpoint host the browser's push
					// service gave the subscription. Tests simulate an expired
					// subscription so the cleanup side-effect (row removal) is
					// observable without needing to decrypt the push payload.
					if (url.hostname === "push.example.test") {
						return new Response(null, { status: 410 });
					}
					// The Claude spam classifier calls the real Anthropic API over
					// fetch(); stub it too. Tests steer the verdict by including a
					// marker string in the email body/subject, which ends up in the
					// request's message content.
					if (url.hostname === "api.anthropic.com") {
						const body = await request.clone().text();
						if (body.includes("TRIGGER_CLAUDE_ERROR")) {
							return new Response("mock error", { status: 500 });
						}
						// Replies that are not a bare verdict. Real ones look like
						// these: a word of preamble, decoration around the word, or
						// the model declining and returning no content at all.
						const reply = (text: string, stopReason = "end_turn") =>
							new Response(
								JSON.stringify({
									content: text ? [{ type: "text", text }] : [],
									stop_reason: stopReason,
								}),
								{
									status: 200,
									headers: { "content-type": "application/json" },
								},
							);
						if (body.includes("TRIGGER_CLAUDE_PREAMBLE")) {
							return reply("Based on the sender domain, this is SPAM");
						}
						if (body.includes("TRIGGER_CLAUDE_REFUSAL")) {
							return reply("", "refusal");
						}
						if (body.includes("TRIGGER_CLAUDE_DECORATED")) {
							return reply("**NOT_SPAM**");
						}
						// Answers with the shape of the request rather than a
						// verdict, so a test can see what actually went out --
						// the prefilled assistant turn is what keeps a preamble
						// from being produced in the first place, and nothing else
						// in the suite can observe it.
						if (body.includes("TRIGGER_CLAUDE_ECHO_SHAPE")) {
							const sent = JSON.parse(body) as {
								max_tokens: number;
								messages: { role: string }[];
							};
							const prefilled = sent.messages.at(-1)?.role === "assistant";
							return reply(
								`assistant-turn=${prefilled ? "yes" : "no"} max_tokens=${sent.max_tokens}`,
							);
						}
						// Matched case-insensitively so the marker can be planted in
						// a field the worker normalizes on the way through -- an
						// SPF/DKIM/DMARC verdict is lowercased before it reaches
						// the request, and a test that asserts those verdicts
						// arrive needs the marker to survive that.
						const verdict = body
							.toUpperCase()
							.includes("TRIGGER_CLAUDE_SPAM")
							? "SPAM"
							: "NOT_SPAM";
						return new Response(
							JSON.stringify({ content: [{ type: "text", text: verdict }] }),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						);
					}
					return fetch(request);
				},
			},
		}),
	],
	test: {
		// Replaces the pool's removed `isolatedStorage`; see reset-storage.ts.
		setupFiles: [fileURLToPath(new URL("./reset-storage.ts", import.meta.url))],
	},
	esbuild: {
		target: "esnext",
	},
});

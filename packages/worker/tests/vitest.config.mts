import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * How many times each fail-then-recover marker has been asked, so the stub
 * below can fail the first n and then answer.
 *
 * It has to live out here: the stub is called once per attempt, and counting
 * inside it would start again from zero every time.
 *
 * Keyed by family *and* tag. Keyed by tag alone, `OVERLOAD_ONCE_1` and
 * `BLOCKED_ONCE_1` shared one count -- so whichever ran second found the
 * count already spent, was answered on its first attempt, and passed without
 * ever meeting the failure it was written for. It passed with the retry
 * removed too, which is how it was caught.
 */
const overloadAttempts = new Map<string, number>();

/** Every message the Resend stub below accepted; see "/__sent". */
const resendSent: { authorization: string; body: unknown }[] = [];

export default defineConfig({
	plugins: [
		cloudflareTest({
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
						// What was sent, and with whose key, for a test to ask
						// after. The key decides who pays, and "the person whose
						// mail it is" was a rule nothing checked: this stub took
						// any request, so a send with somebody else's key -- or
						// none -- passed every test. See whose-key.test.ts.
						if (url.pathname === "/__sent") {
							return Response.json(resendSent);
						}
						const authorization = request.headers.get("Authorization");
						// As Resend answers a request without a key.
						if (!authorization?.startsWith("Bearer re_")) {
							return Response.json(
								{
									statusCode: 401,
									name: "missing_api_key",
									message: "Missing API key in the authorization header",
								},
								{ status: 401 },
							);
						}
						const body = await request.clone().text();
						resendSent.push({ authorization, body: JSON.parse(body) });
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
					// A push service that takes the message, and one that is
					// down: what counts as announced is what a service took.
					if (url.hostname === "push-ok.example.test") {
						return new Response(null, { status: 201 });
					}
					if (url.hostname === "push-down.example.test") {
						return new Response(null, { status: 503 });
					}
					// The Claude spam classifier calls the real Anthropic API over
					// fetch(); stub it too. Tests steer the verdict by including a
					// marker string in the email body/subject, which ends up in the
					// request's message content.
					if (url.hostname === "api.anthropic.com") {
						const body = await request.clone().text();
						// The key-check endpoint sends a fixed message of its own, so
						// a marker cannot be planted in it. The key can be: it is
						// what that endpoint is testing, and it reaches here in the
						// header.
						const steer = `${body} ${request.headers.get("x-api-key") ?? ""}`;
						if (body.includes("TRIGGER_CLAUDE_ERROR")) {
							return new Response("mock error", { status: 500 });
						}
						/*
						 * Overloaded for the first N attempts, then fine.
						 *
						 * `529 overloaded_error` is Anthropic saying it is busy this
						 * second, and it is the failure that has actually been
						 * letting mail into the inbox unclassified. A stub that
						 * always fails cannot tell a retry from a single attempt --
						 * both end in the same recorded failure. One that stops
						 * failing can: the verdict only arrives if something asked
						 * again.
						 *
						 * The count is kept per tag and lives across requests in
						 * this worker process, so each test uses a tag of its own.
						 */
						const overload = /TRIGGER_CLAUDE_OVERLOAD_([A-Z0-9]+)_(\d+)/.exec(
							steer,
						);
						if (overload) {
							const tag = overload[1];
							const failuresWanted = Number(overload[2]);
							const key = `overload:${tag}`;
							const seen = (overloadAttempts.get(key) ?? 0) + 1;
							overloadAttempts.set(key, seen);
							if (seen <= failuresWanted) {
								return new Response(
									JSON.stringify({
										type: "error",
										error: {
											type: "overloaded_error",
											message: "Overloaded",
										},
									}),
									{
										status: 529,
										headers: { "content-type": "application/json" },
									},
								);
							}
							return new Response(
								JSON.stringify({ content: [{ type: "text", text: " SPAM" }] }),
								{
									status: 200,
									headers: { "content-type": "application/json" },
								},
							);
						}
						// The two refusals that used to be recorded as one reason,
						// and the shape that separates them: the API answers in JSON
						// and names its own error type, while anything standing in
						// front of it answers with a page and never reaches the API
						// at all.
						const refusal = (status: number, type: string) =>
							new Response(
								JSON.stringify({
									type: "error",
									error: { type, message: "refused" },
								}),
								{ status, headers: { "content-type": "application/json" } },
							);
						if (steer.includes("TRIGGER_CLAUDE_401")) {
							return refusal(401, "authentication_error");
						}
						if (steer.includes("TRIGGER_CLAUDE_403")) {
							return refusal(403, "permission_error");
						}
						if (steer.includes("TRIGGER_CLAUDE_EDGE_403")) {
							return new Response(
								"<html><title>Sorry, you have been blocked</title></html>",
								{ status: 403, headers: { "content-type": "text/html" } },
							);
						}
						// The one that actually happened in production, and the
						// reason the "JSON means the API answered" rule had to
						// go: JSON, and `forbidden` is not a word the API uses.
						if (steer.includes("TRIGGER_CLAUDE_FOREIGN_403")) {
							return refusal(403, "forbidden");
						}
						/*
						 * The same refusal, from something that says who it is,
						 * and only for the first n attempts.
						 *
						 * `403 forbidden` has happened repeatedly on the live
						 * mailbox and cleared on its own -- classified mail at
						 * 09:39, blocked at 14:01, same key. That is a temporary
						 * failure, which is what makes retrying it right, and the
						 * headers are what would say who is doing the blocking:
						 * nothing recorded has ever said.
						 *
						 * The headers are the production ones now, including the
						 * colo -- `-HKG`, Cloudflare's Hong Kong data centre,
						 * which is not on Anthropic's published list of regions
						 * it supports access from. And no `request-id`: that
						 * header is minted by the Messages API, so its absence is
						 * what says the call never got there. The successful
						 * answer below has one, and a different colo, so a test
						 * can set the two against each other.
						 */
						const blocked = /TRIGGER_CLAUDE_BLOCKED_([A-Z0-9]+)_(\d+)/.exec(
							steer,
						);
						if (blocked) {
							const tag = blocked[1];
							const failuresWanted = Number(blocked[2]);
							const key = `blocked:${tag}`;
							const seen = (overloadAttempts.get(key) ?? 0) + 1;
							overloadAttempts.set(key, seen);
							if (seen <= failuresWanted) {
								return new Response(
									JSON.stringify({
										type: "error",
										error: { type: "forbidden", message: "refused" },
									}),
									{
										status: 403,
										headers: {
											"content-type": "application/json",
											server: "cloudflare",
											"cf-ray": "a354afa3a9618488-HKG",
										},
									},
								);
							}
							return new Response(
								JSON.stringify({ content: [{ type: "text", text: " SPAM" }] }),
								{
									status: 200,
									headers: { "content-type": "application/json" },
								},
							);
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
						const verdict = body.toUpperCase().includes("TRIGGER_CLAUDE_SPAM")
							? "SPAM"
							: "NOT_SPAM";
						// Answered, and carrying what a real answer carries.
						// Measured against api.anthropic.com: every response
						// through it has `server: cloudflare` and a `cf-ray`,
						// including ones the API itself produced, so those two
						// say only that Cloudflare was in the path. `request-id`
						// is the API's own, and its colo is not the blocked
						// response's -- which is the whole point of recording
						// this on successes as well.
						return new Response(
							JSON.stringify({ content: [{ type: "text", text: verdict }] }),
							{
								status: 200,
								headers: {
									"content-type": "application/json",
									server: "cloudflare",
									"cf-ray": "b7d0e1f2a3c45566-NRT",
									"request-id": "req_011CehH1qEZmDWwon5Yu3W7U",
								},
							},
						);
					}
					/*
					 * Turnstile's siteverify, steered by what is sent to it, the way
					 * the real one answers -- in the real one's order, measured on
					 * 2026-09-29 from a GitHub runner: no secret first, then no
					 * token, and only then whether the secret is known. So with no
					 * token it never says the secret is unknown. An earlier version
					 * of this stub asked about the secret first, and a test that
					 * relied on that passed while Cloudflare would have refused.
					 *
					 * - no secret is `missing-input-secret`;
					 * - no token is `missing-input-response`, whatever the secret;
					 * - a secret containing INVALID_SECRET is one Cloudflare does not
					 *   know (`invalid-input-secret`), answered with a 400 as the
					 *   real one does;
					 * - the token `PASS:<secret>` passes -- a token belongs to one
					 *   widget, so it passes only with that widget's secret, which
					 *   is what lets a test hand over a mismatched pair;
					 * - UNANSWERED gets a page instead of JSON;
					 * - anything else is `invalid-input-response`.
					 */
					if (url.hostname === "challenges.cloudflare.com") {
						const form = new URLSearchParams(await request.clone().text());
						const secret = form.get("secret") ?? "";
						const token = form.get("response") ?? "";
						const answer = (
							success: boolean,
							codes: string[] = [],
							status = 200,
						) =>
							new Response(
								JSON.stringify({
									success,
									"error-codes": codes,
									hostname: "local.test",
								}),
								{ status, headers: { "content-type": "application/json" } },
							);
						if (!secret) return answer(false, ["missing-input-secret"], 400);
						if (!token) return answer(false, ["missing-input-response"]);
						if (secret.includes("INVALID_SECRET")) {
							return answer(false, ["invalid-input-secret"], 400);
						}
						if (token === "UNANSWERED") {
							return new Response("<html>bad gateway</html>", {
								status: 502,
							});
						}
						if (token === `PASS:${secret}`) return answer(true);
						return answer(false, ["invalid-input-response"]);
					}
					// Anything not stubbed above is refused, and says which host. It
					// was handed to node's fetch, as though to reach the network --
					// and measured, that never worked: node could not read
					// Miniflare's Request, so every such call failed with "Failed to
					// parse URL from [object Request]", which named nothing. Refusing
					// on purpose keeps a test from ever reaching a real service, and
					// says what to stub.
					throw new Error(
						`No network in the tests: ${new URL(request.url).host} is not stubbed in vitest.config.mts`,
					);
				},
			},
		}),
	],
	test: {
		// Fifteen seconds, not vitest's five. Measured over the whole suite on
		// a quiet machine: 24 tests take over 1.5s and one 4.6s with no budget
		// of its own -- 35 sign-ins, each a real PBKDF2 at 100,000 iterations.
		// The time is the work (hashing, real retry backoff, archives of a
		// hundred and fifty messages), and a CI runner is slower by a factor
		// nobody controls. A per-test budget has to be remembered on every new
		// test, and forgetting it took a deploy down twice. A test that hangs
		// now says so after fifteen seconds rather than five.
		testTimeout: 15_000,
		// Replaces the pool's removed `isolatedStorage`; see reset-storage.ts.
		setupFiles: [fileURLToPath(new URL("./reset-storage.ts", import.meta.url))],
	},
	esbuild: {
		target: "esnext",
	},
});

import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	esbuild: {
		target: "esnext",
	},
	test: {
		poolOptions: {
			workers: {
				singleWorker: true,
				wrangler: {
					configPath: "../dev/wrangler.jsonc",
				},
				miniflare: {
					r2Persist: false,
					isolatedStorage: true,
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
							return new Response(JSON.stringify({ id: "mock-resend-id" }), {
								status: 200,
								headers: { "content-type": "application/json" },
							});
						}
						// The Claude spam classifier calls the real Anthropic API over
						// fetch(); stub it too. Tests steer the verdict by including a
						// marker string in the email body/subject, which ends up in the
						// request's message content.
						// Web Push sends to whatever endpoint host the browser's push
						// service gave the subscription. Tests simulate an expired
						// subscription so the cleanup side-effect (row removal) is
						// observable without needing to decrypt the push payload.
						if (url.hostname === "push.example.test") {
							return new Response(null, { status: 410 });
						}
						if (url.hostname === "api.anthropic.com") {
							const body = await request.clone().text();
							if (body.includes("TRIGGER_CLAUDE_ERROR")) {
								return new Response("mock error", { status: 500 });
							}
							const verdict = body.includes("TRIGGER_CLAUDE_SPAM")
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
			},
		},
	},
});

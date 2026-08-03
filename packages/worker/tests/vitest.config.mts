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
					outboundService: (request) => {
						const url = new URL(request.url);
						if (url.hostname === "api.resend.com") {
							return new Response(JSON.stringify({ id: "mock-resend-id" }), {
								status: 200,
								headers: { "content-type": "application/json" },
							});
						}
						return fetch(request);
					},
				},
			},
		},
	},
});

import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		// The utilities under test parse HTML with DOMParser, so they need a
		// real DOM rather than a stubbed one.
		environment: "jsdom",
		include: ["src/**/*.test.ts"],
	},
});

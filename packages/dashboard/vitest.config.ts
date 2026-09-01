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
		// Vitest stubs every CSS import to an empty string by default, and it
		// does so by the file's extension -- so `main.css?raw` came back empty
		// too, and a test could not read the stylesheet at all. Nothing here
		// imports a stylesheet for its effect; cursorAffordance.test.ts reads
		// this one as text, which is what this turns back on.
		css: true,
	},
});

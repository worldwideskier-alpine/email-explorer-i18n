import { fileURLToPath, URL } from "node:url";

import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import vueJsx from "@vitejs/plugin-vue-jsx";
import vueDevTools from "vite-plugin-vue-devtools";

// https://vite.dev/config/
export default defineConfig({
	plugins: [vue(), vueJsx(), vueDevTools()],
	build: {
		// The one chunk over vite's 500 kB is the app itself (875 kB, 269 kB
		// gzipped); the catalogues are already their own chunks. Splitting the
		// app further -- the editor behind compose, say -- would have a page
		// left open over a deploy ask for a chunk of the build before it, and
		// a deploy does not serve those: measured on production on 2026-09-29,
		// three earlier builds' entry chunks and an earlier catalogue all came
		// back as the page itself (200, text/html), and a dynamic import of
		// each failed in Chromium. So it stays one piece on purpose, and the
		// limit is set just above it: the warning still comes if the app grows
		// past it.
		chunkSizeWarningLimit: 1000,
	},
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
});

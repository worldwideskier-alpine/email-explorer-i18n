import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { i18n, initLocale } from "./i18n";
import router from "./router";
import "./assets/main.css";

const app = createApp(App);

app.use(createPinia());
app.use(router);
app.use(i18n);

// Catalogues are fetched rather than bundled, so the first one has to arrive
// before the first paint. Mounting first would flash the untranslated keys.
initLocale().then(() => {
	app.mount("#app");
});

if ("serviceWorker" in navigator) {
	window.addEventListener("load", () => {
		navigator.serviceWorker.register("/sw.js").catch((e) => {
			console.error("Service worker registration failed:", e);
		});
	});
}

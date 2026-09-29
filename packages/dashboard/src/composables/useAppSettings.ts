import { readonly, ref } from "vue";
import api from "@/services/api";

interface AppSettings {
	auth: {
		registerEnabled: boolean;
	};
	accountRecovery: {
		enabled: boolean;
	};
	// Absent from a Worker older than the page.
	turnstile?: {
		siteKey: string | null;
	};
}

const settings = ref<AppSettings | null>(null);
const isLoading = ref(false);
const error = ref<string | null>(null);

export function useAppSettings() {
	const fetchSettings = async () => {
		isLoading.value = true;
		error.value = null;
		try {
			const response = await api.getAppSettings();
			settings.value = response.data;
		} catch (e: any) {
			error.value = e.message || "Failed to fetch app settings";
			console.error("Failed to fetch app settings:", e);
		} finally {
			isLoading.value = false;
		}
	};

	const isRegistrationEnabled = () => {
		return settings.value?.auth.registerEnabled ?? false;
	};

	const isAccountRecoveryEnabled = () => {
		return settings.value?.accountRecovery.enabled ?? false;
	};

	/** The site key the sign-in forms render Turnstile with, or null. */
	const turnstileSiteKey = () => settings.value?.turnstile?.siteKey ?? null;

	return {
		settings: readonly(settings),
		isLoading: readonly(isLoading),
		error: readonly(error),
		fetchSettings,
		isRegistrationEnabled,
		isAccountRecoveryEnabled,
		turnstileSiteKey,
	};
}

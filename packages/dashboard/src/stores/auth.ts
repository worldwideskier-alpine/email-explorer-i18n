import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import api from "@/services/api";
import { translateApiError } from "@/utils/apiError";

export interface User {
	id: string;
	email: string;
	isAdmin: boolean;
}

export type AccountRole = "root" | "admin" | "member";

export interface Session {
	id: string;
	userId: string;
	email: string;
	isAdmin: boolean;
	/**
	 * Absent on a session stored by an older build of this dashboard, so it
	 * falls back to the least privileged role rather than to the most.
	 */
	role?: AccountRole;
	expiresAt: number;
}

export const useAuthStore = defineStore("auth", () => {
	const session = ref<Session | null>(null);
	const loading = ref(false);
	const error = useLocalizedMessage();

	const isAuthenticated = computed(() => session.value !== null);
	const isAdmin = computed(() => session.value?.isAdmin ?? false);
	/**
	 * Which screen this account belongs on. Decided by the Worker from the
	 * deployment's configuration -- see roles.ts there -- and only ever used
	 * here to pick a view. The server checks it again on every root-only
	 * request, because a typed URL skips this entirely.
	 */
	const role = computed(() => session.value?.role ?? "member");
	const isRoot = computed(() => role.value === "root");
	const currentUser = computed(() =>
		session.value
			? {
					id: session.value.userId,
					email: session.value.email,
					isAdmin: session.value.isAdmin,
				}
			: null,
	);

	// Load session from localStorage on init
	const storedSession = localStorage.getItem("session");
	if (storedSession) {
		try {
			session.value = JSON.parse(storedSession);
		} catch (e) {
			localStorage.removeItem("session");
		}
	}

	async function register(email: string, password: string) {
		loading.value = true;
		error.value = null;
		try {
			const response = await api.register(email, password);
			// After registration, login
			await login(email, password);
			return response.data;
		} catch (err: any) {
			const fromApi = err.response?.data?.error;
			error.value = () => translateApiError(fromApi, "Registration failed");
			throw err;
		} finally {
			loading.value = false;
		}
	}

	async function login(email: string, password: string) {
		loading.value = true;
		error.value = null;
		try {
			const response = await api.login(email, password);
			session.value = response.data;
			// Store session in localStorage
			localStorage.setItem("session", JSON.stringify(response.data));
			// Set default auth header for future requests
			api.setAuthToken(response.data.id);
			return response.data;
		} catch (err: any) {
			const fromApi = err.response?.data?.error;
			error.value = () => translateApiError(fromApi, "Login failed");
			throw err;
		} finally {
			loading.value = false;
		}
	}

	async function logout() {
		loading.value = true;
		try {
			if (session.value) {
				await api.logout();
			}
		} catch (err) {
			console.error("Logout error:", err);
		} finally {
			session.value = null;
			localStorage.removeItem("session");
			api.clearAuthToken();
			loading.value = false;
		}
	}

	async function checkAuth() {
		if (!session.value) return false;

		// Check if session is expired
		if (session.value.expiresAt < Date.now()) {
			await logout();
			return false;
		}

		loading.value = true;
		try {
			const response = await api.getCurrentUser();
			// Update session with fresh data.
			//
			// The role has to be refreshed here as well as at sign-in. It is
			// decided by the deployment's configuration, so it can change
			// while somebody is signed in -- naming a root address for the
			// first time is exactly that -- and a session stored before the
			// change would otherwise keep its old role until the person
			// happened to sign out. They would set the variable, redeploy,
			// reload, and see no difference.
			session.value = {
				...session.value,
				email: response.data.email,
				isAdmin: response.data.isAdmin,
				role: response.data.role,
			};
			localStorage.setItem("session", JSON.stringify(session.value));
			return true;
		} catch (_err) {
			await logout();
			return false;
		} finally {
			loading.value = false;
		}
	}

	return {
		role,
		isRoot,
		session,
		loading,
		error,
		isAuthenticated,
		isAdmin,
		currentUser,
		register,
		login,
		logout,
		checkAuth,
	};
});

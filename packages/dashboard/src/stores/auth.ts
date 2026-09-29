import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import api from "@/services/api";
import { rebindPushSubscription } from "@/services/push";
import { whenSessionEnds } from "@/services/sessionEnd";
import { useContactStore } from "@/stores/contacts";
import { useEmailStore } from "@/stores/emails";
import { useFolderStore } from "@/stores/folders";
import { useMailboxStore } from "@/stores/mailboxes";
import { useSearchStore } from "@/stores/search";
import { useUIStore } from "@/stores/ui";
import { translateApiError } from "@/utils/apiError";

export interface User {
	id: string;
	email: string;
}

/**
 * Two roles, different in kind rather than in degree: root runs the
 * deployment and makes the accounts; an administrator is one of the people
 * using it. There used to be a third, "member" -- somebody handed access to a
 * mailbox they did not register. Nothing ever made one on purpose; it existed
 * because the account screen could create accounts that owned nothing, and it
 * gave a role column a third word to print. Both are gone.
 */
export type AccountRole = "root" | "admin";

export interface Session {
	id: string;
	userId: string;
	email: string;
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
	/**
	 * There is deliberately no `isAdmin` anywhere in this file.
	 *
	 * It read the Worker's legacy `is_admin` column, which is set for the
	 * first account ever registered and for no other -- there is no way to
	 * set it on a second one. Anything gated on it was therefore available to
	 * one particular person rather than to a role, and the two places that
	 * did gate on it were a backup-restore control and this person's own
	 * badge. Administrators are equal; what varies between them is which
	 * mailboxes they hold, which is `personHoldsMailbox` on the Worker and
	 * "can you open this screen at all" here.
	 *
	 * Not offering it as a computed was the first half. The field stayed on
	 * the stored Session, so `authStore.session?.isAdmin` still type-checked
	 * and still read the flag -- a way back to the same defect that the
	 * compiler allowed and a test looking for `authStore.isAdmin` could not
	 * see. It is off the interface now, and off what login and checkAuth
	 * store, so reaching for it does not compile. The Worker still sends the
	 * field; nothing here keeps it.
	 */
	/**
	 * Which screen this account belongs on. Decided by the Worker -- see
	 * roles.ts there -- and only ever used here to pick a view. The server
	 * checks it again on every root-only request, because a typed URL skips
	 * this entirely. A session stored without one is read as an
	 * administrator's, the role that is not root; the "member" it used to
	 * fall back to is gone.
	 */
	const role = computed<AccountRole>(() => session.value?.role ?? "admin");
	const isRoot = computed(() => role.value === "root");
	const currentUser = computed(() =>
		session.value
			? {
					id: session.value.userId,
					email: session.value.email,
				}
			: null,
	);

	// A request refused for want of a session ends it here as well, so the
	// next navigation goes to sign-in (see api.ts).
	whenSessionEnds(() => {
		session.value = null;
	});

	// Load session from localStorage on init
	const storedSession = localStorage.getItem("session");
	if (storedSession) {
		try {
			session.value = JSON.parse(storedSession);
		} catch (e) {
			localStorage.removeItem("session");
		}
	}

	async function register(
		email: string,
		password: string,
		turnstileToken?: string,
	) {
		loading.value = true;
		error.value = null;
		try {
			const response = await api.register(email, password, turnstileToken);
			// The Worker signs the new account in itself. Asking /login next
			// would need a second Turnstile token, and the widget's one has just
			// been spent on this request.
			if (response.data?.session) adopt(response.data.session);
			else await login(email, password);
			return response.data;
		} catch (err: any) {
			const fromApi = err.response?.data?.error;
			error.value = () => translateApiError(fromApi, "Registration failed");
			throw err;
		} finally {
			loading.value = false;
		}
	}

	/**
	 * Keeps a session the Worker has just started.
	 *
	 * Field by field, not the whole response. It used to be
	 * `session.value = response.data`, and the Worker's login response still
	 * carries `isAdmin`. So the flag went on living in the reactive session
	 * and in localStorage no matter what this file said about it, and the
	 * type saying it was gone only meant a cast would reach a real value.
	 * Naming what is kept is what makes "not kept" true rather than asserted.
	 */
	function adopt(started: Session) {
		session.value = {
			id: started.id,
			userId: started.userId,
			email: started.email,
			role: started.role,
			expiresAt: started.expiresAt,
		};
		// Store session in localStorage
		localStorage.setItem("session", JSON.stringify(session.value));
		// Set default auth header for future requests
		api.setAuthToken(started.id);
		void rebindPushSubscription();
		return session.value;
	}

	async function login(
		email: string,
		password: string,
		turnstileToken?: string,
	) {
		loading.value = true;
		error.value = null;
		try {
			const response = await api.login(email, password, turnstileToken);
			return adopt(response.data);
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
			// What this person had open goes with them. The stores outlive the
			// session in the tab, so the next person to sign in there saw the
			// last one's search results until they searched for something.
			useSearchStore().$reset();
			useEmailStore().$reset();
			useMailboxStore().$reset();
			useFolderStore().$reset();
			useContactStore().$reset();
			useUIStore().$reset();
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
			// the Worker's answer, and a session is kept for thirty days: one
			// stored by an older build, or before the person it belongs to
			// changed, would otherwise keep what it was stored with until
			// they happened to sign out.
			session.value = {
				...session.value,
				email: response.data.email,
				role: response.data.role,
			};
			localStorage.setItem("session", JSON.stringify(session.value));
			void rebindPushSubscription();
			return true;
		} catch (err: any) {
			// Only the server saying the session is no good ends it. A dropped
			// connection or a 5xx while the page loads used to sign the person
			// out -- revoking the session on the server too if the logout got
			// through -- for a hiccup.
			const status = err?.response?.status;
			if (status === 401 || status === 403) {
				await logout();
				return false;
			}
			return true;
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
		currentUser,
		register,
		login,
		logout,
		checkAuth,
	};
});

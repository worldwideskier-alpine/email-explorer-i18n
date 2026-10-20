import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { useLocalizedMessage } from "@/composables/useLocalizedMessage";
import { i18n } from "@/i18n";
import api from "@/services/api";
import {
	letGoOfThisBrowsersSubscription,
	rebindPushSubscription,
} from "@/services/push";
import { sessionEnded, whenSessionEnds } from "@/services/sessionEnd";
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

/**
 * The sign-outs the server has not heard about yet; see signOut. A list, one
 * token each: it was one slot, so a sign-out still waiting was overwritten by
 * the next -- written down before it is sent, and crossed off when it
 * succeeded -- and the earlier session was never ended on the server.
 */
const PENDING_SIGN_OUT = "signOutPending";

/** Enough for any one browser; past it the oldest is let go. */
const PENDING_SIGN_OUTS_KEPT = 10;

function pendingSignOuts(): string[] {
	let stored: string | null;
	try {
		stored = localStorage.getItem(PENDING_SIGN_OUT);
	} catch {
		return [];
	}
	if (!stored) return [];
	try {
		const list: unknown = JSON.parse(stored);
		if (Array.isArray(list)) {
			return list.filter(
				(token): token is string => typeof token === "string" && token !== "",
			);
		}
	} catch {
		// Not JSON: one token, bare, as an older build kept it.
	}
	return [stored];
}

function keepPendingSignOuts(tokens: string[]) {
	try {
		if (tokens.length === 0) localStorage.removeItem(PENDING_SIGN_OUT);
		else {
			localStorage.setItem(
				PENDING_SIGN_OUT,
				JSON.stringify(tokens.slice(-PENDING_SIGN_OUTS_KEPT)),
			);
		}
	} catch {
		// Private browsing with storage refused: nothing more to be done.
	}
}

/**
 * Whether the server took the sign-out. Tried twice, a second apart.
 *
 * Only a success counts. A 401 used to count as "already over", when the
 * Worker answered a sign-out with an ended session that way; it signs out
 * any session it is named now and never answers 401, so a 401 is somebody
 * in front of it -- an Access sign-in that has lapsed, or an older Worker
 * during a rollback -- and the server has heard nothing.
 */
async function tellTheServer(send: () => Promise<unknown>): Promise<boolean> {
	for (let attempt = 0; attempt < 2; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, 1000));
		try {
			await send();
			return true;
		} catch (err: any) {
			console.error("Logout error:", err);
		}
	}
	return false;
}

function rememberPendingSignOut(token: string) {
	const tokens = pendingSignOuts();
	if (!tokens.includes(token)) keepPendingSignOuts([...tokens, token]);
}

/** Crosses off this sign-out, and only this one. */
function pendingSignOutHeard(token: string) {
	const tokens = pendingSignOuts();
	if (tokens.includes(token)) {
		keepPendingSignOuts(tokens.filter((pending) => pending !== token));
	}
}

/**
 * Sends the sign-outs that did not reach the server last time, each with its
 * own token. With fetch rather than through api.ts, whose 401 handling would
 * end the session of whoever is signed in now.
 *
 * And, when nobody is signed in here, lets go of this browser's push
 * subscription: signOut lets go of it first, but a tab closed before the
 * browser had done so left it subscribed, and the next sign-in in this
 * browser hands the subscription to whoever that is. Not while somebody is
 * signed in, whose subscription it may be by now.
 */
async function finishPendingSignOut() {
	const tokens = pendingSignOuts();
	if (tokens.length === 0) return;
	if (!localStorage.getItem("session")) {
		await letGoOfThisBrowsersSubscription();
	}
	for (const token of tokens) {
		const sent = await tellTheServer(async () => {
			const response = await fetch("/api/v1/auth/logout", {
				method: "POST",
				headers: { Authorization: `Bearer ${token}` },
			});
			if (!response.ok) {
				throw new Error(`sign-out answered ${response.status}`);
			}
		});
		if (sent) pendingSignOutHeard(token);
	}
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

	/**
	 * What this person had open goes with them. The stores outlive the
	 * session in the tab, so the next person to sign in there saw the last
	 * one's mailboxes and search results -- after a sign-out, and after a
	 * session that simply ran out, which left everything in place. Answers
	 * still on their way are dropped by api.ts (see sessionGeneration).
	 *
	 * The composer is not closed here: a session that ends while something
	 * is being written leaves the text on screen to be copied (api.ts). It
	 * goes when the next session starts, in adopt.
	 */
	function forgetThisPerson() {
		session.value = null;
		localStorage.removeItem("session");
		api.clearAuthToken();
		useSearchStore().$reset();
		useEmailStore().$reset();
		useMailboxStore().$reset();
		useFolderStore().$reset();
		useContactStore().$reset();
	}

	// A request refused for want of a session ends it here as well, so the
	// next navigation goes to sign-in (see api.ts).
	whenSessionEnds(forgetThisPerson);

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
		// A new person, or the same one again: nothing of what was on screen
		// before carries over, the half-written message of an ended session
		// and its original included.
		forgetThisPerson();
		useUIStore().$reset();
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

	/**
	 * Signing out on purpose: the buttons. Here, on the server, and for this
	 * browser's notifications.
	 *
	 * This browser lets go of its push subscription first, whatever the
	 * server says afterwards, so a device signed out on purpose is told
	 * nothing more about anybody's mail -- not even, once its session has
	 * run out, to open the app (see sessionEndedByItself for the other kind
	 * of end). First, and not after the server has answered: that is two
	 * attempts and a second's wait, and a tab closed in the meantime stayed
	 * subscribed. The Worker's row goes with the session.
	 *
	 * The server's half used to be allowed to fail in silence: the screen
	 * signed out and the session, its cookie and its push subscription lived
	 * on for thirty days -- on a shared computer, for whoever came next. So
	 * the sign-out is written down before it is sent, and crossed off only
	 * once the server has it; one that still fails after a second try is
	 * sent again the next time this dashboard is opened
	 * (finishPendingSignOut). Written only after both attempts failed, as it
	 * used to be, a tab closed in the second between them lost it.
	 */
	async function signOut() {
		loading.value = true;
		const ending = session.value?.id;
		try {
			await letGoOfThisBrowsersSubscription();
			if (ending) {
				rememberPendingSignOut(ending);
				if (await tellTheServer(() => api.logout(ending))) {
					pendingSignOutHeard(ending);
				}
			}
		} finally {
			sessionEnded();
			useUIStore().$reset();
			loading.value = false;
		}
	}

	/**
	 * A session that has run out, or that the server says is gone: forgotten
	 * here, and nothing else.
	 *
	 * Not a sign-out. Asking the server to end it would delete the push
	 * subscription the Worker uses to tell this device, while its session is
	 * lapsed, to open the app -- the one thing that brings a phone used only
	 * for notifications back. Nor is the browser's subscription let go. And
	 * a message being written stays on screen to be copied, as it does when
	 * a request finds the session gone (api.ts).
	 */
	function sessionEndedByItself() {
		sessionEnded();
	}

	void finishPendingSignOut();

	// The language the Worker tells this device in once its session has run
	// out is the one it last sent; a language picked since is sent too.
	watch(
		() => i18n.global.locale.value,
		() => {
			if (session.value) void rebindPushSubscription();
		},
	);

	/**
	 * Asks the Worker whether the session is still good, and ends it here
	 * only when the Worker says it is not.
	 *
	 * Not by this device's clock. A session past its time here used to be
	 * ended here without a word to the server, and a clock running ahead
	 * showed the sign-in screen while the session lived on there, its device
	 * still told the sender and subject of new mail. The router asks this
	 * again whenever the stored time has passed.
	 */
	async function checkAuth() {
		if (!session.value) return false;

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
			//
			// And only a 401. This route answers 200 or 401; a 403 here comes
			// from the Access check in front of it, which says nothing about
			// this session.
			if (err?.response?.status === 401) {
				sessionEndedByItself();
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
		signOut,
		sessionEndedByItself,
		checkAuth,
	};
});

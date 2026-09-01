import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";
import Account from "@/views/Account.vue";
import Admin from "@/views/Admin.vue";
import ConfirmEmailChange from "@/views/ConfirmEmailChange.vue";
import Contacts from "@/views/Contacts.vue";
import EmailDetail from "@/views/EmailDetail.vue";
import EmailList from "@/views/EmailList.vue";
import EmailSource from "@/views/EmailSource.vue";
import ForgotPassword from "@/views/ForgotPassword.vue";
import Home from "@/views/Home.vue";
import Login from "@/views/Login.vue";
import Mailbox from "@/views/Mailbox.vue";
import NotFound from "@/views/NotFound.vue";
import Register from "@/views/Register.vue";
import ResetPassword from "@/views/ResetPassword.vue";
import Root from "@/views/Root.vue";
import SearchResults from "@/views/SearchResults.vue";
import Settings from "@/views/Settings.vue";

const router = createRouter({
	history: createWebHistory(import.meta.env.BASE_URL),
	routes: [
		{
			path: "/login",
			name: "Login",
			component: Login,
			meta: { title: "Login", public: true },
		},
		{
			path: "/register",
			name: "Register",
			component: Register,
			meta: { title: "Register", public: true },
		},
		{
			path: "/forgot-password",
			name: "ForgotPassword",
			component: ForgotPassword,
			meta: { title: "Forgot Password", public: true },
		},
		{
			path: "/reset-password",
			name: "ResetPassword",
			component: ResetPassword,
			meta: { title: "Reset Password", public: true },
		},
		{
			// Opened from the link in the confirmation mail, which may well be
			// read on a device that has never signed in.
			path: "/confirm-email-change",
			name: "ConfirmEmailChange",
			component: ConfirmEmailChange,
			meta: { title: "Confirm Email Change", public: true },
		},
		{
			path: "/account",
			name: "Account",
			component: Account,
			meta: { title: "Account", requiresAuth: true, hasLanguageSwitcher: true },
		},
		{
			path: "/",
			name: "Home",
			component: Home,
			meta: { title: "Home", requiresAuth: true, hasLanguageSwitcher: true },
		},
		{
			path: "/root",
			name: "Root",
			component: Root,
			meta: {
				title: "Accounts",
				requiresAuth: true,
				requiresRoot: true,
				hasLanguageSwitcher: true,
			},
		},
		{
			path: "/admin",
			name: "Admin",
			component: Admin,
			meta: {
				title: "Admin Panel",
				requiresAuth: true,
				requiresAdmin: true,
				hasLanguageSwitcher: true,
			},
		},
		{
			path: "/mailbox/:mailboxId",
			name: "Mailbox",
			component: Mailbox,
			// This view has a row of actions of its own (its Header) and puts
			// the language control in it. App.vue floats one on every route
			// without this flag; leaving it off here would show two.
			meta: { requiresAuth: true, hasLanguageSwitcher: true },
			redirect: (to) => {
				return {
					name: "EmailList",
					params: { mailboxId: to.params.mailboxId, folder: "inbox" },
				};
			},
			children: [
				{
					path: "emails/:folder",
					name: "EmailList",
					component: EmailList,
					meta: { title: "Emails" },
				},
				{
					path: "email/:id",
					name: "EmailDetail",
					component: EmailDetail,
					meta: { title: "Email" },
				},
				{
					path: "email/:id/source",
					name: "EmailSource",
					component: EmailSource,
					meta: { title: "Email Source" },
				},
				{
					path: "contacts",
					name: "Contacts",
					component: Contacts,
					meta: { title: "Contacts" },
				},
				{
					path: "settings",
					name: "Settings",
					component: Settings,
					meta: { title: "Settings" },
				},
				{
					path: "search",
					name: "SearchResults",
					component: SearchResults,
					meta: { title: "Search" },
				},
			],
		},
		{
			path: "/:pathMatch(.*)*",
			name: "NotFound",
			component: NotFound,
			meta: { title: "Not Found" },
		},
	],
});

// Navigation guard for authentication
/**
 * The stored session is asked about once per page load, and not again.
 *
 * It is written at sign-in and then trusted for thirty days, which is wrong
 * in two ways that both bite. The role is decided by the deployment's
 * configuration, so naming a root address for the first time changes it while
 * people are signed in -- and without this they would set the variable,
 * redeploy, reload, and see no difference at all. And an account deleted by
 * root keeps a session that still looks valid here, so the screens render
 * and every request behind them fails.
 *
 * Once per load rather than per navigation: this is a request, and moving
 * between two screens is not new information.
 */
let sessionRefreshed = false;

router.beforeEach(async (to, _from, next) => {
	const authStore = useAuthStore();

	if (!sessionRefreshed && authStore.session) {
		sessionRefreshed = true;
		// Signs the person out by itself if the session is no longer good,
		// which the checks below then act on.
		await authStore.checkAuth();
	}
	const isPublicRoute = to.meta.public === true;
	const requiresAuth = to.meta.requiresAuth !== false; // Auth required by default
	const requiresAdmin = to.meta.requiresAdmin === true;
	const requiresRoot = to.meta.requiresRoot === true;

	// Initialize auth token if exists
	if (authStore.session && !authStore.loading) {
		const sessionData = authStore.session;
		// Check if session is expired
		if (sessionData.expiresAt < Date.now()) {
			await authStore.logout();
		}
	}

	if (!isPublicRoute && requiresAuth && !authStore.isAuthenticated) {
		// Redirect to login if not authenticated
		next({ name: "Login", query: { redirect: to.fullPath } });
	} else if (requiresRoot && !authStore.isRoot) {
		next({ name: "Home" });
	} else if (requiresAdmin && !authStore.isAdmin) {
		// Redirect to home if not admin
		next({ name: "Home" });
	} else if (
		authStore.isRoot &&
		requiresAuth &&
		!isPublicRoute &&
		to.name !== "Root"
	) {
		// Root owns no mailbox, so the mailbox list it would otherwise land on
		// is an empty screen saying it has none. Its home is the account list.
		next({ name: "Root" });
	} else if (
		isPublicRoute &&
		authStore.isAuthenticated &&
		(to.name === "Login" ||
			to.name === "Register" ||
			to.name === "ForgotPassword")
	) {
		// Redirect to home if already authenticated and trying to access login/register/forgot-password
		next({ name: authStore.isRoot ? "Root" : "Home" });
	} else {
		next();
	}
});

router.afterEach((to) => {
	if (to.meta.title) {
		document.title = `${to.meta.title} - Email Explorer`;
	} else {
		document.title = "Email Explorer";
	}
});

export default router;

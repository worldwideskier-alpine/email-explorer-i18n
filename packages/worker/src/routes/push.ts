import { contentJson, OpenAPIRoute } from "chanfana";
import type { Context } from "hono";
import { z } from "zod";
import type { Env, Session } from "../types";

type AppContext = Context<{ Bindings: Env; Variables: { session?: Session } }>;

const ErrorResponseSchema = z.object({
	error: z.string(),
});

const VapidPublicKeyResponseSchema = z.object({
	publicKey: z.string(),
});

export class GetVapidPublicKey extends OpenAPIRoute {
	schema = {
		summary: "Get the VAPID public key used for Web Push subscriptions",
		operationId: "getVapidPublicKey",
		tags: ["Push"],
		responses: {
			"200": {
				description: "VAPID public key",
				...contentJson(VapidPublicKeyResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		// No private key, no push: the public half alone makes the switch look
		// usable while nothing could ever be delivered. A fork inherits this
		// repository's public key in wrangler.jsonc, so that was the default
		// for anybody who had not made a pair of their own.
		if (!c.env.VAPID_PRIVATE_KEY) return c.json({ publicKey: "" });
		return c.json({
			publicKey:
				publicKeyOf(c.env.VAPID_PRIVATE_KEY) ?? c.env.VAPID_PUBLIC_KEY ?? "",
		});
	}
}

/**
 * The public half of the key the Worker signs with, from the private one.
 *
 * The public key was a variable of its own, with this deployment's as the
 * default in wrangler.jsonc: a fork that made its own pair and set only the
 * private half (a secret) handed browsers this deployment's public key, and
 * every push was refused by the push service for a signature that did not
 * match -- with nothing on any screen to say why. A P-256 JWK carries the
 * public point as `x` and `y`, so the pair cannot disagree. The variable is
 * the fallback for a private key written without them.
 */
export function publicKeyOf(privateJwk: string): string | null {
	try {
		const { x, y } = JSON.parse(privateJwk) as { x?: unknown; y?: unknown };
		if (typeof x !== "string" || typeof y !== "string") return null;
		const bytes = (b64url: string) =>
			Uint8Array.from(
				atob(b64url.replace(/-/g, "+").replace(/_/g, "/")),
				(ch) => ch.charCodeAt(0),
			);
		const point = new Uint8Array([4, ...bytes(x), ...bytes(y)]);
		if (point.length !== 65) return null;
		return btoa(String.fromCharCode(...point))
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");
	} catch {
		return null;
	}
}

const SubscribeRequestSchema = z.object({
	endpoint: z.string().url(),
	keys: z.object({
		p256dh: z.string(),
		auth: z.string(),
	}),
});

const SuccessResponseSchema = z.object({
	status: z.string(),
});

export class PostPushSubscribe extends OpenAPIRoute {
	schema = {
		summary: "Register a push subscription for the current user",
		operationId: "subscribePush",
		tags: ["Push"],
		request: {
			body: contentJson(SubscribeRequestSchema),
		},
		responses: {
			"200": {
				description: "Subscription saved",
				...contentJson(SuccessResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { endpoint, keys } = data.body as {
			endpoint: string;
			keys: { p256dh: string; auth: string };
		};

		const authId = c.env.MAILBOX.idFromName("AUTH");
		const authDO = c.env.MAILBOX.get(authId);
		await authDO.savePushSubscription(
			session.userId,
			session.id,
			endpoint,
			keys,
		);

		return c.json({ status: "subscribed" });
	}
}

const UnsubscribeRequestSchema = z.object({
	endpoint: z.string().url(),
});

export class PostPushUnsubscribe extends OpenAPIRoute {
	schema = {
		summary: "Remove a push subscription",
		operationId: "unsubscribePush",
		tags: ["Push"],
		request: {
			body: contentJson(UnsubscribeRequestSchema),
		},
		responses: {
			"200": {
				description: "Subscription removed",
				...contentJson(SuccessResponseSchema),
			},
			"401": {
				description: "Unauthorized",
				...contentJson(ErrorResponseSchema),
			},
		},
	};

	async handle(c: AppContext) {
		const session = c.get("session");
		if (!session) {
			return c.json({ error: "Unauthorized" }, 401);
		}

		const data = await this.getValidatedData<typeof this.schema>();
		const { endpoint } = data.body;

		const authId = c.env.MAILBOX.idFromName("AUTH");
		const authDO = c.env.MAILBOX.get(authId);
		await authDO.removePushSubscription(session.userId, endpoint);

		return c.json({ status: "unsubscribed" });
	}
}

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
		return c.json({ publicKey: c.env.VAPID_PUBLIC_KEY || "" });
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
		await authDO.savePushSubscription(session.userId, endpoint, keys);

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
		await authDO.removePushSubscription(endpoint);

		return c.json({ status: "unsubscribed" });
	}
}

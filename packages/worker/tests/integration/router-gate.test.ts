import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import SOURCE from "../../src/index.ts?raw";
import { authenticatedFetch, createMailbox, testAuthBeforeAll } from "./utils";

/**
 * The mailbox gate runs for every path under a mailbox, however the path is
 * spelled.
 *
 * The gate is wildcard middleware on the per-request app in fetch()
 * (`/api/v1/mailboxes/:mailboxId/*`, src/index.ts), and which middleware a
 * path meets is the router's to decide. Hono's RegExpRouter before 4.13.16
 * (GHSA-h7mg-cq63-vhpq) compiled its wildcards so that they did not match a
 * line terminator: a path with `%0A`, `%0D`, `%E2%80%A8` or `%E2%80%A9` in
 * it met no wildcard middleware at all. Here that only reached the router's
 * 404, since no route matched either and nothing behind the not-found
 * handler does any work -- measured on 4.13.14 over every mailbox route --
 * but a gate that holds only because nothing happens to sit behind it is
 * one change away from a hole. So this asks every mailbox route, as
 * somebody who does not hold the mailbox, with each terminator at the end
 * of the path and inside its last segment, and wants the gate's own answer.
 *
 * The routes are read from the source, as the probe that measured this read
 * them, so a new mailbox route is asked without being listed here.
 */

const THEIRS = "theirs@example.org";
const THEIR_SEGMENT = encodeURIComponent(THEIRS);
const TERMINATORS = ["%0A", "%0D", "%E2%80%A8", "%E2%80%A9"];

const mailboxRoutes = [
	...SOURCE.matchAll(/openapi\.(get|post|put|delete|patch)\(\s*"([^"]+)"/g),
]
	.map(([, method, path]) => ({ method: method.toUpperCase(), path }))
	.filter(({ path }) => path.startsWith("/api/v1/mailboxes/:mailboxId"));

/** A route's path with their mailbox in it and every other parameter filled. */
const theirPath = (template: string) =>
	template.replace(":mailboxId", THEIR_SEGMENT).replace(/:[A-Za-z]+/g, "x");

/** Each terminator at the end of the path, and inside its last segment. */
const crafted = (path: string) =>
	TERMINATORS.flatMap((terminator) => {
		const cut = path.lastIndexOf("/") + 2;
		return [
			`${path}${terminator}`,
			`${path.slice(0, cut)}${terminator}${path.slice(cut)}`,
		];
	});

describe("the mailbox gate, on paths with an encoded line terminator", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
		// Somebody else's mailbox, which the signed-in person does not hold.
		await env.BUCKET.put(`mailboxes/${THEIRS}.json`, JSON.stringify({}));
		await env.MAILBOX.get(env.MAILBOX.idFromName("AUTH")).giveMailboxToPerson(
			"someone-else",
			THEIRS,
		);
	});

	it("finds the mailbox routes to ask", () => {
		// Read from the source; an empty list would pass everything below.
		expect(mailboxRoutes.length).toBeGreaterThan(20);
	});

	it.each(mailboxRoutes)(
		"refuses $method $path from somebody who does not hold it",
		async ({ method, path }) => {
			const answers: string[] = [];
			for (const one of crafted(theirPath(path))) {
				const response = await authenticatedFetch(`http://local.test${one}`, {
					method,
					headers: { "Content-Type": "application/json" },
					body: method === "GET" || method === "DELETE" ? undefined : "{}",
				});
				const body = await response.text();
				answers.push(`${method} ${one} -> ${response.status} ${body}`);
			}
			for (const answer of answers) {
				expect(answer).toMatch(
					/ -> 403 \{"error":"You don't have access to this mailbox"\}$/,
				);
			}
		},
	);
});

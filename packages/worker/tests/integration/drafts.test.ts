import { beforeEach, describe, expect, it } from "vitest";
import {
	authenticatedFetch,
	createMailbox,
	mailboxId,
	testAuthBeforeAll,
} from "./utils";

describe("Draft Emails Integration Tests", () => {
	beforeEach(async () => {
		await testAuthBeforeAll();
		await createMailbox();
	});

	it("should create a new draft and list it under the draft folder", async () => {
		const response = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/drafts`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					to: "recipient@example.com",
					from: mailboxId,
					subject: "My Draft",
					html: "<p>Draft body</p>",
				}),
			},
		);

		expect(response.status).toBe(201);
		const body = await response.json<any>();
		expect(body.status).toBe("saved");
		expect(body.id).toBeDefined();

		const listResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=draft`,
		);
		const emails = await listResponse.json<any[]>();
		expect(emails).toHaveLength(1);
		expect(emails[0].id).toBe(body.id);
		expect(emails[0].subject).toBe("My Draft");
		expect(emails[0].recipient).toBe("recipient@example.com");
	});

	it("should allow saving a draft with an empty recipient/subject", async () => {
		const response = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/drafts`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ from: mailboxId }),
			},
		);

		expect(response.status).toBe(201);
	});

	it("should update an existing draft's content", async () => {
		const createResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/drafts`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					to: "recipient@example.com",
					from: mailboxId,
					subject: "Original Subject",
					html: "<p>Original body</p>",
				}),
			},
		);
		const { id: draftId } = await createResponse.json<any>();

		const updateResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/drafts/${draftId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					to: "newrecipient@example.com",
					from: mailboxId,
					subject: "Updated Subject",
					html: "<p>Updated body</p>",
				}),
			},
		);

		expect(updateResponse.status).toBe(200);

		const getResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${draftId}`,
		);
		const email = await getResponse.json<any>();
		expect(email.subject).toBe("Updated Subject");
		expect(email.recipient).toBe("newrecipient@example.com");
		expect(email.body).toBe("<p>Updated body</p>");
	});

	it("should 404 when updating a draft id that does not exist", async () => {
		const response = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/drafts/does-not-exist`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					from: mailboxId,
					to: "a@example.com",
					subject: "x",
					html: "x",
				}),
			},
		);

		expect(response.status).toBe(404);
	});

	it("should 404 when trying to update a non-draft email through the drafts endpoint", async () => {
		const sendResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					to: "recipient@example.com",
					from: mailboxId,
					subject: "Sent Email",
					html: "<p>Sent body</p>",
				}),
			},
		);
		const { id: sentEmailId } = await sendResponse.json<any>();

		const updateResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/drafts/${sentEmailId}`,
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					from: mailboxId,
					to: "a@example.com",
					subject: "x",
					html: "x",
				}),
			},
		);

		expect(updateResponse.status).toBe(404);
	});

	it("should let a draft be deleted via the generic delete-email endpoint", async () => {
		const createResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/drafts`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					from: mailboxId,
					to: "a@example.com",
					subject: "x",
					html: "x",
				}),
			},
		);
		const { id: draftId } = await createResponse.json<any>();

		const deleteResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails/${draftId}`,
			{ method: "DELETE" },
		);
		expect(deleteResponse.status).toBe(204);

		const listResponse = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/emails?folder=draft`,
		);
		const emails = await listResponse.json<any[]>();
		expect(emails).toHaveLength(0);
	});

	it("should include the draft folder in the folder list", async () => {
		const response = await authenticatedFetch(
			`http://local.test/api/v1/mailboxes/${mailboxId}/folders`,
		);
		const folders = await response.json<any[]>();
		expect(folders.map((f) => f.id)).toContain("draft");
	});
});

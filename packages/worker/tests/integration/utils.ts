import {env, runInDurableObject, SELF} from "cloudflare:test";

export const mailboxId = "test@example.com";
export const sessionToken = "dummy_token";
export const userId = "user1";

export const testAuthBeforeAll = async () => {
    // @ts-expect-error
    const doId = env.MAILBOX.idFromName("AUTH");
    // @ts-expect-error
    const doStub = env.MAILBOX.get(doId);

    await runInDurableObject(doStub, async (_instance, state) => {
        const sql = state.storage.sql;
        const now = Date.now();
        const expiresAt = now + 30 * 24 * 60 * 60 * 1000;
        sql.exec("INSERT OR REPLACE into sessions (id, user_id, expires_at, created_at) values (?, ?, ?, ?)", sessionToken, userId, expiresAt, now);
        sql.exec("INSERT OR REPLACE into users (id, email, password_hash, is_admin, person_id, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?)", userId, 'aa', 'bb', 1, personId, now, now);
    });
}

/** The person the fixture login belongs to. A login always belongs to one. */
export const personId = "person-test";

/**
 * Puts a mailbox in the bucket and gives it to the fixture person.
 *
 * The claim is not decoration. A mailbox made through the API belongs to the
 * person who made it, and that claim is the only thing that makes it visible.
 * A fixture that wrote only the bucket object made a mailbox belonging to
 * nobody -- something the API cannot produce -- and it was visible anyway
 * only because an account with the admin flag used to skip the question.
 */
export async function createMailbox(settings = {}) {
    // @ts-expect-error
    await env.BUCKET.put(`mailboxes/${mailboxId}.json`, JSON.stringify(settings));
    // @ts-expect-error
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName("AUTH"));
    await stub.giveMailboxToPerson(personId, mailboxId);
}

// Helper to make authenticated request
export const authenticatedFetch = (url: string, options: RequestInit = {}) => {
    return SELF.fetch(url, {
        ...options,
        headers: {
            ...options.headers,
            Authorization: `Bearer ${sessionToken}`,
        },
    });
};

/**
 * Creates the mailbox these tests share, through the same endpoint a real
 * user would. This used to be a POST to /api/v1/debug/create-mailbox -- a
 * test fixture that was registered on the production router. The fixture
 * lives here now instead.
 */
export async function createDummyMailbox() {
    const response = await authenticatedFetch("http://local.test/api/v1/mailboxes", {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({
            email: mailboxId,
            name: "Test User",
            settings: {
                signature: {enabled: true, text: "Sent from my awesome email client"},
            },
        }),
    });
    // 409 means an earlier call in the same test already created it.
    if (response.status !== 201 && response.status !== 409) {
        throw new Error(`could not create the test mailbox: HTTP ${response.status}`);
    }
}

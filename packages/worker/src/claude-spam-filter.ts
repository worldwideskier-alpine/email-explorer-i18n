// Second-stage spam classification, layered on top of the SPF/DKIM/DMARC
// check in spam-filter.ts. Only called for mail that already passed that
// first check (mail that fails it is spam regardless), and only when the
// mailbox owner has configured a Claude API key -- this is opt-in per
// mailbox, never a global default, and callers must skip it entirely when
// no key is set rather than calling this with an empty string.

const CLAUDE_MODEL = "claude-haiku-4-5-20251001";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";
const MAX_BODY_CHARS = 4000;
const REQUEST_TIMEOUT_MS = 10_000;

const SYSTEM_PROMPT =
	"You are a spam filter for a small business's inbox. Classify the email " +
	"below as SPAM or NOT_SPAM. Respond with exactly one word -- SPAM or " +
	"NOT_SPAM -- and nothing else. If you are unsure, respond NOT_SPAM so " +
	"legitimate mail is never lost.";

function stripHtml(html: string): string {
	return html
		.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

interface ClassifyInput {
	apiKey: string;
	subject: string;
	from: string;
	text?: string;
	html?: string;
}

/**
 * Best-effort: any failure (network error, non-2xx response, malformed
 * response, timeout) falls back to "inbox" so a flaky API call never causes
 * a real email to be lost.
 */
export async function classifyWithClaude(
	input: ClassifyInput,
): Promise<"inbox" | "spam"> {
	const body = (
		input.text ||
		(input.html && stripHtml(input.html)) ||
		""
	).slice(0, MAX_BODY_CHARS);

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

	try {
		const response = await fetch(CLAUDE_API_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-api-key": input.apiKey,
				"anthropic-version": "2023-06-01",
			},
			body: JSON.stringify({
				model: CLAUDE_MODEL,
				max_tokens: 8,
				temperature: 0,
				system: SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: `From: ${input.from}\nSubject: ${input.subject}\n\n${body}`,
					},
				],
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			console.error(
				`Claude spam classification failed: ${response.status} ${await response.text()}`,
			);
			return "inbox";
		}

		const data = await response.json<{
			content?: { type: string; text?: string }[];
		}>();
		const verdict = data.content
			?.map((block) => block.text || "")
			.join("")
			.trim()
			.toUpperCase();

		return verdict?.startsWith("SPAM") ? "spam" : "inbox";
	} catch (err) {
		console.error("Claude spam classification error:", err);
		return "inbox";
	} finally {
		clearTimeout(timeout);
	}
}

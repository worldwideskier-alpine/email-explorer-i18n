// The hook behind CLAUDE.md's reply rules, registered in .claude/settings.json
// for three events (reply-rules-judge.mjs has the rules themselves):
//
//   UserPromptSubmit  puts the rules next to every prompt, so they are close
//                     at hand however long the conversation has grown.
//   PostToolBatch     reads the text written just before the tools ran and,
//                     if it broke a rule, says so alongside the results. A
//                     line already on screen cannot be taken back; this keeps
//                     the next one from repeating it.
//   Stop              checks the reply that is about to end the turn and
//                     sends it back to be rewritten, at most MAX_REWRITES
//                     times, so a rule this file gets wrong cannot loop.
//
// Only the main conversation is checked: a subagent's text (agent_id set) is
// data for the main agent, not something the owner reads.
//
// It never stands in the way of the work. Anything it cannot read -- a
// transcript not yet written, a state file it cannot open -- it leaves alone
// and exits 0 with nothing to say.

import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decideProgress,
	decidePrompt,
	decideStop,
	replyTexts,
	textsBeforeTools,
} from "./reply-rules-judge.mjs";

// The transcript of a long session runs to tens of megabytes; what these
// checks need is near its end. A reply longer than this is checked on its
// final message alone.
const TAIL_BYTES = 8 * 1024 * 1024;

function tailRows(path) {
	if (!path) return [];
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, TAIL_BYTES);
		const buf = Buffer.alloc(length);
		readSync(fd, buf, 0, length, size - length);
		const lines = buf.toString("utf8").split("\n");
		if (length < size) lines.shift(); // cut mid-row
		const rows = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				rows.push(JSON.parse(line));
			} catch {
				// a row still being written
			}
		}
		return rows;
	} finally {
		closeSync(fd);
	}
}

function statePath(input) {
	const dir = join(input.scratchpad_dir || tmpdir(), "reply-rules");
	mkdirSync(dir, { recursive: true });
	return join(dir, `${String(input.session_id).replace(/[^\w-]/g, "_")}.json`);
}

function rewritesSoFar(input) {
	try {
		const state = JSON.parse(readFileSync(statePath(input), "utf8"));
		return state.promptId === input.prompt_id ? state.rewrites : 0;
	} catch {
		return 0;
	}
}

function recordRewrite(input, rewrites) {
	writeFileSync(
		statePath(input),
		JSON.stringify({ promptId: input.prompt_id, rewrites }),
	);
}

function stop(input) {
	const finalText = input.last_assistant_message ?? "";
	let earlierTexts = [];
	try {
		const texts =
			replyTexts(tailRows(input.transcript_path), input.prompt_id) ?? [];
		// The final message may or may not have reached the transcript yet.
		if (texts.length && texts[texts.length - 1].trim() === finalText.trim())
			texts.pop();
		earlierTexts = texts;
	} catch {
		// checked on its own
	}
	const rewrites = rewritesSoFar(input);
	const answer = decideStop({ finalText, earlierTexts, rewrites });
	if (answer) recordRewrite(input, rewrites + 1);
	return answer;
}

function progress(input) {
	const ids = (input.tool_calls ?? [])
		.map((c) => c.tool_use_id)
		.filter(Boolean);
	if (!ids.length) return null;
	return decideProgress(textsBeforeTools(tailRows(input.transcript_path), ids));
}

function main() {
	const input = JSON.parse(readFileSync(0, "utf8"));
	if (input.agent_id) return null;
	switch (input.hook_event_name) {
		case "UserPromptSubmit":
			return decidePrompt();
		case "PostToolBatch":
			return progress(input);
		case "Stop":
			return stop(input);
		default:
			return null;
	}
}

try {
	const answer = main();
	if (answer) process.stdout.write(JSON.stringify(answer));
} catch {
	// Never block the work because the checker failed.
}

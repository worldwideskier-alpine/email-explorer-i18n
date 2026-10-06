// The hook behind CLAUDE.md's reply rules, registered in .claude/settings.json
// for three events (reply-rules-judge.mjs has the rules and runHook):
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
// data for the main agent, not something the owner reads. REPLY_RULES=off in
// the environment turns it off for a run nobody reads as a reply.
//
// It never stands in the way of the work. Anything it cannot read -- the
// judge itself, a transcript not yet written, a state file -- it leaves alone
// and exits 0 with nothing to say. That is why the judge is imported inside
// the try: imported at the top, a fork's broken edit of it showed a hook
// error on every prompt, tool call and reply.

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

// The transcript of a long session runs to tens of megabytes; what these
// checks need is near its end. A reply longer than this is checked on its
// final message alone.
const TAIL_BYTES = 8 * 1024 * 1024;

function readTail(path) {
	const fd = openSync(path, "r");
	try {
		const size = fstatSync(fd).size;
		const length = Math.min(size, TAIL_BYTES);
		const buf = Buffer.alloc(length);
		readSync(fd, buf, 0, length, size - length);
		return { text: buf.toString("utf8"), cut: length < size };
	} finally {
		closeSync(fd);
	}
}

async function main() {
	const { runHook, rowsFromTail } = await import("./reply-rules-judge.mjs");
	const input = JSON.parse(readFileSync(0, "utf8"));
	const dir = join(input?.scratchpad_dir || tmpdir(), "reply-rules");
	const file = (key) =>
		join(dir, `${String(key).replace(/[^\w-]/g, "_")}.json`);
	return runHook(input, {
		env: process.env,
		readRows(path) {
			if (!path) return [];
			const { text, cut } = readTail(path);
			return rowsFromTail(text, cut);
		},
		readState(key) {
			try {
				return JSON.parse(readFileSync(file(key), "utf8"));
			} catch {
				return null;
			}
		},
		writeState(key, value) {
			mkdirSync(dir, { recursive: true });
			writeFileSync(file(key), JSON.stringify(value));
		},
	});
}

main().then(
	(answer) => {
		if (answer) process.stdout.write(JSON.stringify(answer));
	},
	() => {
		// Never stand in the way of the work because the checker failed.
	},
);

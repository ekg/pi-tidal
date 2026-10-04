// Clean a raw GHC/ghci stderr burst into ONE legible, bounded message.
//
// The REPL's stderr arrives hard-wrapped to the terminal width (words split
// mid-token), decorated with ANSI cursor/color codes that scatter single
// characters over lines, followed by a full CALL STACK dump that floods the
// user's scrollback. This module turns that into a flat block:
//   - strip ANSI escapes and control characters (incl. \r);
//   - cut the rarely-useful CALL STACK sections with an explicit marker;
//   - rejoin hard wraps so words are not split, without gluing the • bullets;
//   - collapse blank runs, trim the block, and cap length with a marker.
//
// Used by extensions/tidal.ts when reporting `[tidal] REPL error` bursts.

const ANSI_RE = /\x1B(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\)|[@-Z\\-_])/g;
// every C0 control char except \n and \t (tab becomes a space below)
const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0D-\x1F\x7F]/g;

const CALL_STACK_RE = /^\**\s*(?:PROTECTED\s+)?CALL\s*STACK/i;

// Lines that always begin a new logical line, never a wrap continuation:
// blank lines, GHC's • bullets, and location headers (`<interactive>:3:1`,
// `src/Foo.hs:12:5: error:`) — a continuation of a wrapped line never looks
// like these.
function startsNewLogicalLine(line) {
	return (
		line.trim() === "" ||
		/^\s*[•‣▪]\s/.test(line) ||
		/^\s*[-*]\s/.test(line) ||
		/^\s*</.test(line) ||
		/^\s*\S+:\d+:\d+/.test(line)
	);
}

// A line only continues the previous one when that previous line is not a
// finished sentence AND the next line looks like a word continuation: it
// starts at column 0 with a lowercase letter and carries no bullet/indent
// marker. GHC prints designed line breaks (bullets, aligned `with actual
// type:` lines) with leading indentation — those must stay separate.
function continuesPrevious(prev, next) {
	if (prev === "" || prev.trim() === "") return false;
	if (/[.:;!?]$/.test(prev.trimEnd())) return false;
	if (/^\s/.test(next)) return false;
	return !startsNewLogicalLine(next);
}

// Hard wraps can break mid-word (`Couldn't mat` + `ch`). A lowercase letter
// butting a lowercase/digit edge is a mid-word split (join with no space);
// anything else was wrapped at a word boundary (join with one space).
function wrapJoiner(prev, next) {
	const left = prev.trimEnd().at(-1);
	const right = next.trimStart().at(0);
	const midWord = left !== undefined && right !== undefined && /[a-z0-9]$/.test(left) && /^[a-z]/.test(right);
	return midWord ? "" : " ";
}

// Clean one raw stderr burst. Options: maxLines (default 20), maxChars
// (default 2000). Returns the cleaned, bounded text ("" for empty input).
export function cleanReplError(raw, opts = {}) {
	const maxLines = opts.maxLines ?? 20;
	const maxChars = opts.maxChars ?? 2000;
	if (!raw) return "";

	const notes = [];
	let physical = String(raw)
		.replace(ANSI_RE, "")
		.replace(CONTROL_RE, "")
		.replace(/\t/g, " ")
		.split("\n")
		.map((l) => l.replace(/[ \t]+$/, ""));

	// 1) cut CALL STACK sections before rejoining: the frames are stack noise
	// that the user cannot act on, and gluing them into wrap-joined lines
	// would only inflate the message
	const stackIdx = physical.findIndex((l) => CALL_STACK_RE.test(l) || /CallStack \(from/i.test(l));
	if (stackIdx >= 0) {
		const omitted = physical.length - stackIdx - 1;
		physical = physical.slice(0, stackIdx + 1); // keep the header for context
		if (omitted > 0) notes.push(`… (call stack truncated, ${omitted} line${omitted === 1 ? "" : "s"} omitted)`);
	}

	// 2) rejoin hard wraps into logical lines
	const logical = [];
	for (const line of physical) {
		const prev = logical.length > 0 ? logical[logical.length - 1] : null;
		if (prev !== null && continuesPrevious(prev, line)) {
			logical[logical.length - 1] =
				prev.trimEnd() + wrapJoiner(prev, line) + line.trimStart();
		} else {
			logical.push(line);
		}
	}

	// 3) collapse blank runs, trim edges and indentation
	const collapsed = [];
	for (const line of logical) {
		if (line.trim() === "" && (collapsed.length === 0 || collapsed[collapsed.length - 1] === "")) continue;
		collapsed.push(line.trim() === "" ? "" : line.trim());
	}
	while (collapsed.length > 0 && collapsed[collapsed.length - 1] === "") collapsed.pop();

	// 4) bound the message: the error itself is at the top, so keep the head
	let lines = collapsed;
	if (lines.length > maxLines) {
		const n = lines.length - maxLines;
		notes.push(`… (${n} more line${n === 1 ? "" : "s"} truncated)`);
		lines = lines.slice(0, maxLines);
	}
	let text = lines.join("\n");
	for (const note of notes) text += (text ? "\n" : "") + note;

	// 5) char cap (cut on a line boundary when possible)
	if (text.length > maxChars) {
		const cut = text.lastIndexOf("\n", maxChars);
		const head = cut > maxChars * 0.5 ? text.slice(0, cut) : text.slice(0, maxChars);
		text = head + `\n… (${text.length - head.length} chars truncated)`;
	}
	return text.trim();
}

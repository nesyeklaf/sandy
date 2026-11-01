import { pathOf } from "./messages.ts";
import { estimateTokens } from "./tokens.ts";
import type { LogEntry } from "./types.ts";

/**
 * Skills the agent loaded, found in the log so a cut can name them. A skill's instructions reach the context in two
 * ways: the agent reads its `SKILL.md` with a tool, directly, inside codemode or from a shell, or pi expands
 * `/skill:name` into a user message holding the whole file. After a cut that archives the load, the instructions are
 * gone while the work they govern may go on, so the cut block lists each skill with its path and the entry that
 * loaded it. The agent reads the file again; nothing of the skill is copied into the block.
 *
 * Recognition is lexical and host-free: a call's `path` argument ending in `/SKILL.md`, a path ending so inside any
 * other string argument of a tool call (a codemode script, a shell command), except calls of tools that write files,
 * and pi's `<skill name location>` tag in a user message. A path in quotes may hold spaces. A path with a shell or
 * template variable is skipped rather than guessed, and so is one longer than {@link MAX_PATH_CHARS}. A skill counts
 * once by name, however its path was spelled. A path built at run time, or a skill file under another name, is not seen.
 *
 * Scans are bounded: every string is searched forward once for the file name, and each hit walks back at most
 * {@link MAX_PATH_CHARS}, so the work is linear in the arguments.
 */
export interface SkillRef {
	readonly name: string;
	readonly path: string;
}

/** A skill's newest load, with its position in reading order (0 for the newest entry). */
export interface SkillLoad extends SkillRef {
	readonly id: string;
	readonly at: number;
}

/** Skills listed in a cut block at most. */
export const SKILLS_LISTED = 10;
/** Token budget of the section; part of what every cut carries. */
export const SKILLS_SECTION_TOKENS = 600;
/** Longest path accepted; a longer one is skipped, never shortened into a path that does not exist. */
export const MAX_PATH_CHARS = 512;
/** Longest skill name accepted. pi allows 64 characters. */
const MAX_NAME_CHARS = 64;
/** Distinct skills a fold remembers; loads beyond are only counted. */
const SKILLS_HELD = 4 * SKILLS_LISTED;
const WRITE_TOOLS = new Set(["edit", "write"]);
const FILE = "/SKILL.md";
/** Characters that end an unquoted path, walking back from the file name. */
const UNQUOTED_STOP = new Set([..." \t\r\n\"'`()<>[],;|&*?="]);
const QUOTES = new Set(['"', "'", "`"]);
const NAME = /^[^\s"'`<>/\\$]{1,64}$/;
const SKILL_TAG = /<skill name="([^"<>\n]{1,64})" location="([^"<>\n]{1,512})">/g;
const BODY_END = "</skill>";
/** How deep a call's arguments are searched for strings. */
const ARGS_DEPTH = 4;

/** A path that can be read back as written: not too long, no variable, a valid skill name as its folder. */
function skillRef(path: string, name = path.split("/").at(-2) ?? ""): SkillRef | undefined {
	if (path.length > MAX_PATH_CHARS || /[$\n]/.test(path) || /\$\{|\{\{/.test(path)) return undefined;
	if (name.length > MAX_NAME_CHARS || !NAME.test(name) || name === "." || name === "..") return undefined;
	return { name, path };
}

/**
 * The path that ends at `end` (just after `/SKILL.md`), walking back at most {@link MAX_PATH_CHARS}. A quoted string
 * is the path when it starts like one (`/`, `~/`, `./`, `../`) or holds no whitespace; otherwise, as in
 * `"cat ~/skills/x/SKILL.md"`, the path is its last word.
 */
function pathEndingAt(text: string, end: number): string | undefined {
	const next = text[end] ?? "";
	if (/[\w.-]/.test(next)) return undefined;
	if (QUOTES.has(next)) {
		const quoted = walkBack(text, end, next);
		if (quoted !== undefined && (/^(\/|~\/|\.\.?\/)/.test(quoted) || !/\s/.test(quoted))) return quoted;
	}
	return walkBack(text, end, undefined);
}

/** The characters before `end` back to `quote`, or to an unquoted stop when there is none. */
function walkBack(text: string, end: number, quote: string | undefined): string | undefined {
	const floor = Math.max(0, end - MAX_PATH_CHARS - 1);
	let start = end - FILE.length;
	while (start > floor) {
		const char = text[start - 1] ?? "";
		if (quote ? char === quote || char === "\n" : UNQUOTED_STOP.has(char)) break;
		start--;
	}
	if (start === floor && floor > 0) return undefined;
	if (quote && text[start - 1] !== quote) return undefined;
	return text.slice(start, end);
}

/** Every skill path inside a longer string, in order. */
function skillPathsIn(text: string): string[] {
	const paths: string[] = [];
	for (let hit = text.indexOf(FILE); hit !== -1; hit = text.indexOf(FILE, hit + FILE.length)) {
		const path = pathEndingAt(text, hit + FILE.length);
		if (path !== undefined) paths.push(path);
	}
	return paths;
}

/** The skills an entry loads, in order of appearance, each once. */
export function skillsLoaded(entry: LogEntry): SkillRef[] {
	const found = new Map<string, SkillRef>();
	const keep = (ref: SkillRef | undefined): void => {
		if (ref && !found.has(ref.name)) found.set(ref.name, ref);
	};
	if (entry.kind === "user" && entry.text.includes("<skill ")) {
		for (const [, name, path] of entry.text.matchAll(SKILL_TAG)) keep(skillRef(path ?? "", name));
	}
	for (const call of entry.toolCalls) {
		if (WRITE_TOOLS.has(call.name)) continue;
		const direct = pathOf(call.args);
		if (direct?.endsWith(FILE)) keep(skillRef(direct.trim()));
		for (const text of stringsOf(call.args, ARGS_DEPTH)) {
			if (text === direct) continue;
			for (const path of skillPathsIn(text)) keep(skillRef(path));
		}
	}
	return [...found.values()];
}

/** The strings in a call's arguments, down to `depth` levels of nesting. */
function stringsOf(value: unknown, depth: number): string[] {
	if (typeof value === "string") return [value];
	if (depth === 0 || typeof value !== "object" || value === null) return [];
	return Object.values(value).flatMap((item) => stringsOf(item, depth - 1));
}

/**
 * A user message with each expanded skill replaced by its tag, so a pinned or masked `/skill:` prompt carries the
 * request instead of the first lines of the skill. A tag without its closing `</skill>` and everything after it stay
 * as they are. Linear: each tag is found once and its end searched forward once.
 */
export function withoutSkillBodies(text: string): string {
	if (!text.includes("<skill ")) return text;
	const tag = new RegExp(SKILL_TAG.source, "g");
	let out = "";
	let from = 0;
	for (let match = tag.exec(text); match !== null; match = tag.exec(text)) {
		const close = text.indexOf(BODY_END, tag.lastIndex);
		if (close === -1) break;
		out += `${text.slice(from, match.index)}<skill name="${match[1]}" location="${match[2]}"/> (instructions under Skills in use)`;
		from = close + BODY_END.length;
		tag.lastIndex = from;
	}
	return out + text.slice(from);
}

/** The newest load of each skill by name, from the log read newest first. Holds at most {@link SKILLS_HELD} skills. */
export class SkillsFold {
	private readonly loads = new Map<string, SkillLoad>();
	private overflow = 0;

	/** The next entry, older than every entry added before; `at` is its position in reading order. */
	add(entry: LogEntry, at: number): void {
		for (const ref of skillsLoaded(entry)) {
			if (this.loads.has(ref.name)) continue;
			if (this.loads.size >= SKILLS_HELD) this.overflow++;
			else this.loads.set(ref.name, { ...ref, id: entry.id, at });
		}
	}

	/**
	 * The section for a cut that keeps history from position `keptAt`, or "" when it archives no skill's newest load.
	 * Newest first, at most {@link SKILLS_LISTED} skills within {@link SKILLS_SECTION_TOKENS}; the rest is counted.
	 */
	section(keptAt: number): string {
		const archived = [...this.loads.values()].filter((load) => load.at > keptAt);
		if (archived.length === 0) return "";
		const head = [
			"## Skills in use",
			"These skills were loaded in the archived history; their instructions are no longer in your context. Before you continue work that one of them governs, read its file again.",
		];
		// Reserve room for the omission note so the whole section stays within budget.
		let used = estimateTokens(`${head.join("\n")}\n(${SKILLS_HELD} older skills not shown; search for SKILL.md)`);
		const lines: string[] = [];
		for (const load of archived) {
			const line = `- ${load.name}: ${load.path} (loaded #${load.id})`;
			const cost = estimateTokens(line) + 1;
			if (lines.length >= SKILLS_LISTED || used + cost > SKILLS_SECTION_TOKENS) break;
			lines.push(line);
			used += cost;
		}
		const omitted = archived.length - lines.length + this.overflow;
		return [...head, ...lines, ...(omitted > 0 ? [`(${omitted} older skills not shown; search for SKILL.md)`] : [])].join(
			"\n",
		);
	}
}

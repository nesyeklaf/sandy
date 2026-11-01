import { withoutSkillBodies } from "./skills.ts";
import type { LogEntry, ToolCallRef } from "./types.ts";

/** Keep head and tail of a long text and mark the omitted middle. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor(max * 0.7);
	const tail = max - head;
	return `${text.slice(0, head)}\n…[${text.length - max} chars omitted]…\n${text.slice(text.length - tail)}`;
}

/** Collapse whitespace and cut to one bounded line. */
export function oneLine(text: string, max: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function formatArgs(args: unknown, max: number): string {
	let json: string;
	try {
		json = JSON.stringify(args) ?? "";
	} catch {
		json = String(args);
	}
	return oneLine(json, max);
}

export function ref(entry: LogEntry): string {
	return `#${entry.id}`;
}

export function label(entry: LogEntry): string {
	switch (entry.kind) {
		case "tool":
			return `tool ${entry.toolName ?? ""}${entry.isError ? " (error)" : ""}`.trim();
		case "custom":
			return "note";
		default:
			return entry.kind;
	}
}

export function formatTime(timestamp: number): string {
	return Number.isFinite(timestamp) && timestamp > 0
		? new Date(timestamp).toISOString().slice(0, 16).replace("T", " ")
		: "unknown time";
}

/** `read({"path":"a.ts"})`: how a call is shown wherever it needs to be recognizable. */
export function formatCall(call: ToolCallRef, max: number): string {
	return `${call.name}(${formatArgs(call.args, max)})`;
}

/** Name of a tool result with the call it answers, e.g. `read({"path":"a.ts"}) error`. */
function toolTitle(entry: LogEntry, max: number): string {
	const name = entry.call ? formatCall(entry.call, max) : (entry.toolName ?? "tool");
	return `${name}${entry.isError ? " error" : ""}`;
}

/** Text the search index sees for an entry: content, tool names and call arguments, including the call a result answers. */
export function searchableText(entry: LogEntry): string {
	const calls = entry.toolCalls.map((call) => formatCall(call, 2_000));
	const answered = entry.call ? formatCall(entry.call, 2_000) : (entry.toolName ?? "");
	return [answered, entry.text, ...calls].filter((part) => part !== "").join("\n");
}

/** Rendering for the historian: what happened, with bounded tool output. */
export function renderForHistorian(entry: LogEntry): string {
	switch (entry.kind) {
		case "user":
			return `[${ref(entry)} user] ${clip(entry.text, 4_000)}`;
		case "assistant": {
			const lines = [`[${ref(entry)} assistant] ${clip(entry.text, 3_000)}`.trimEnd()];
			for (const call of entry.toolCalls) lines.push(`  → ${call.name}(${formatArgs(call.args, 400)})`);
			return lines.join("\n");
		}
		case "tool":
			return `[${ref(entry)} ${toolTitle(entry, 300)}] ${clip(entry.text, 2_000)}`;
		case "custom":
			return `[${ref(entry)} note] ${clip(entry.text, 2_000)}`;
	}
}

/** Compact rendering for the masked tier: reasoning and actions stay, tool output becomes a reference. */
export function renderMasked(entry: LogEntry): string {
	switch (entry.kind) {
		case "user":
			return `[${ref(entry)} user] ${oneLine(withoutSkillBodies(entry.text), 600)}`;
		case "assistant": {
			const calls = entry.toolCalls.map((call) => `${call.name}(${formatArgs(call.args, 160)})`);
			const parts = [oneLine(entry.text, 400), calls.length > 0 ? `→ ${calls.join("; ")}` : ""];
			return `[${ref(entry)} assistant] ${parts.filter((part) => part !== "").join(" ")}`;
		}
		case "tool": {
			const first = entry.text.split("\n").find((line) => line.trim() !== "") ?? "";
			return `[${ref(entry)} ← ${toolTitle(entry, 160)}] ${entry.tokens} tokens archived: ${oneLine(first, 100)}`;
		}
		case "custom":
			return `[${ref(entry)} note] ${oneLine(entry.text, 300)}`;
	}
}

/** Rendering for history_read: the complete entry. */
export function renderFull(entry: LogEntry): string {
	const answers = entry.call ? ` · answers ${formatCall(entry.call, 4_000)}` : "";
	const header = `${ref(entry)} · ${label(entry)}${answers} · ${formatTime(entry.timestamp)}`;
	const calls = entry.toolCalls.map((call) => `→ ${call.name}(${formatArgs(call.args, 4_000)})`);
	return [header, entry.text, ...calls].filter((part) => part !== "").join("\n");
}

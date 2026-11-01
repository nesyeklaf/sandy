/**
 * Messages as pi and Pi Durable store them, turned into the core's log entries. Both hosts store the message shapes of
 * pi-ai, read here without trusting them: a block of an unknown type contributes nothing.
 */
import { estimateTokens } from "./tokens.ts";
import type { LogEntry, ToolCallRef } from "./types.ts";

interface Block {
	readonly type?: unknown;
	readonly text?: unknown;
	readonly id?: unknown;
	readonly name?: unknown;
	readonly arguments?: unknown;
}

/** The text of a message's content, with an image as `[image]`. */
export function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Block[])
		.map((block) => {
			if (block.type === "text" && typeof block.text === "string") return block.text;
			return block.type === "image" ? "[image]" : "";
		})
		.filter((text) => text !== "")
		.join("\n");
}

/** The thinking of an assistant message's content: not searchable, but the model reads it again, so it counts. */
export function thinkingOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return (content as (Block & { thinking?: unknown })[])
		.map((block) => (block.type === "thinking" && typeof block.thinking === "string" ? block.thinking : ""))
		.join("");
}

/** The tool calls of an assistant message's content. */
export function toolCallsOf(content: unknown): ToolCallRef[] {
	if (!Array.isArray(content)) return [];
	return (content as Block[]).flatMap((block) =>
		block.type === "toolCall" && typeof block.name === "string"
			? [{ id: typeof block.id === "string" ? block.id : "", name: block.name, args: block.arguments }]
			: [],
	);
}

function tokensOf(text: string, calls: readonly ToolCallRef[], thinking: string): number {
	let tokens = estimateTokens(text) + estimateTokens(thinking);
	for (const call of calls) tokens += estimateTokens(call.name + (JSON.stringify(call.args) ?? ""));
	return tokens;
}

export function logEntry(
	id: string,
	kind: LogEntry["kind"],
	timestamp: number,
	text: string,
	extra: { toolCalls?: ToolCallRef[]; toolName?: string; isError?: boolean; call?: ToolCallRef; thinking?: string } = {},
): LogEntry {
	const toolCalls = extra.toolCalls ?? [];
	return {
		id,
		kind,
		timestamp,
		text,
		toolCalls,
		...(extra.toolName !== undefined ? { toolName: extra.toolName } : {}),
		...(extra.call ? { call: extra.call } : {}),
		...(extra.isError ? { isError: true } : {}),
		tokens: tokensOf(text, toolCalls, extra.thinking ?? ""),
	};
}

/** The file a tool call names in its `path` argument (or `file_path`, `filePath`). */
export function pathOf(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const record = args as Record<string, unknown>;
	const path = record.path ?? record.file_path ?? record.filePath;
	return typeof path === "string" && path !== "" ? path : undefined;
}

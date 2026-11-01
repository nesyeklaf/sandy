import { estimateTokens } from "../src/core/tokens.ts";
import type { LogEntry, ToolCallRef } from "../src/core/types.ts";

let clock = Date.UTC(2026, 9, 9, 12, 0, 0);

export function entry(
	id: string,
	kind: LogEntry["kind"],
	text: string,
	extra: { toolCalls?: ToolCallRef[]; toolName?: string; isError?: boolean; tokens?: number } = {},
): LogEntry {
	clock += 60_000;
	const toolCalls = extra.toolCalls ?? [];
	return {
		id,
		kind,
		timestamp: clock,
		text,
		toolCalls,
		...(extra.toolName !== undefined ? { toolName: extra.toolName } : {}),
		...(extra.isError ? { isError: true } : {}),
		tokens: extra.tokens ?? estimateTokens(text),
	};
}

/** A synthetic session: per turn a user prompt, an assistant tool call, its result and an answer. */
export function session(turns: number, resultTokens = 1_000): LogEntry[] {
	const entries: LogEntry[] = [];
	for (let turn = 0; turn < turns; turn++) {
		entries.push(entry(`u${turn}`, "user", `Please look at module-${turn} and tell me about fact-${turn}.`));
		entries.push(
			entry(`a${turn}`, "assistant", `Reading module-${turn}.`, {
				toolCalls: [{ id: `c${turn}`, name: "read", args: { path: `src/module-${turn}.ts` } }],
			}),
		);
		entries.push(
			entry(`t${turn}`, "tool", `export const fact${turn} = "value-${turn}";\n${"x".repeat(resultTokens * 4)}`, {
				toolName: "read",
			}),
		);
		entries.push(entry(`r${turn}`, "assistant", `fact-${turn} is value-${turn}.`));
	}
	return entries;
}

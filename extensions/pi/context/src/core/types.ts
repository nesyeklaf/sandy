/** Kinds of context-producing entries in the session log. */
export type EntryKind = "user" | "assistant" | "tool" | "custom";

export interface ToolCallRef {
	readonly id: string;
	readonly name: string;
	readonly args: unknown;
}

/**
 * One context-producing entry of the session log, in branch order.
 *
 * The log is append-only. Everything in this package is a pure function of it, so the
 * model view can always be rebuilt and every derived index can be thrown away.
 */
export interface LogEntry {
	readonly id: string;
	readonly kind: EntryKind;
	/** Unix milliseconds. */
	readonly timestamp: number;
	/** Model-visible text: message text, tool output, or custom content. */
	readonly text: string;
	/** Tool calls of an assistant entry; empty otherwise. */
	readonly toolCalls: readonly ToolCallRef[];
	/** Tool name of a tool-result entry. */
	readonly toolName?: string;
	/** The call a tool-result entry answers, so its output can be found by the call's arguments. */
	readonly call?: ToolCallRef;
	readonly isError?: boolean;
	/** Estimated tokens of the entry as the model sees it. */
	readonly tokens: number;
}

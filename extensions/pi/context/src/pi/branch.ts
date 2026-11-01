import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { NOTEBOOK_KIND, REMINDER_KIND, SUMMARY_KIND, TASK_DONE_KIND } from "../core/kinds.ts";
import { logEntry, textOf, thinkingOf, toolCallsOf } from "../core/messages.ts";
import { readSummaryState, type SummaryState } from "../core/summary.ts";
import { estimateTokens } from "../core/tokens.ts";
import { TOOLS } from "../core/tools.ts";
import type { LogEntry, ToolCallRef } from "../core/types.ts";

/** Everything the extension derives from the active branch of the pi session. */
export interface BranchState {
	readonly entries: readonly LogEntry[];
	/** First log index after the latest compaction; a new cut keeps nothing before it. */
	readonly minKeptIndex: number;
	/** First log index the model currently sees verbatim. */
	readonly visibleFromIndex: number;
	/** Estimated tokens of what the prompt holds from the log: the entries from visibleFromIndex and the latest compaction's summary. */
	readonly visibleTokens: number;
	/** First log index the historian may summarize: history a compaction of someone else archived stays search-only. */
	readonly historianFloorIndex: number;
	readonly summary: SummaryState | undefined;
	readonly notebook: string | undefined;
	/** The notebook was written after the latest compaction, or at all when there was none. */
	readonly notebookCurrent: boolean;
	/** A notebook reminder was appended after the latest compaction. */
	readonly reminded: boolean;
	/** `provider/model` of the last response, the model whose cache holds the prefix. */
	readonly lastModelKey: string | undefined;
	/** Last time the provider cache was used: a response or a cache refresh. */
	readonly lastCacheTouch: number | undefined;
	readonly endsWithCompaction: boolean;
	/** Compactions on this branch that came from this extension. */
	readonly cuts: number;
	/** A finished task was reported and neither a prompt nor a cut followed: the next cut chance is still its. */
	readonly taskCutPending: boolean;
}

type LooseMessage = Record<string, unknown> & { readonly role?: unknown };

function timeOf(message: LooseMessage, entry: SessionEntry): number {
	return typeof message.timestamp === "number" ? message.timestamp : Date.parse(entry.timestamp);
}

export function readBranch(branch: readonly SessionEntry[]): BranchState {
	const entries: LogEntry[] = [];
	let minKeptIndex = 0;
	let compactionKeptId: string | undefined;
	let compactionTokens = 0;
	/** The kept entry of the latest compaction this extension did not make. */
	let foreignKeptId: string | undefined;
	let foreignIndex = 0;
	let summary: SummaryState | undefined;
	let notebook: string | undefined;
	let notebookCurrent = false;
	let reminded = false;
	let lastModelKey: string | undefined;
	let lastCacheTouch: number | undefined;
	let cuts = 0;
	let taskCutPending = false;
	const calls = new Map<string, ToolCallRef>();
	const touch = (time: number) => {
		if (Number.isFinite(time)) lastCacheTouch = Math.max(lastCacheTouch ?? time, time);
	};

	for (const entry of branch) {
		switch (entry.type) {
			case "message": {
				const message = entry.message as unknown as LooseMessage;
				const time = timeOf(message, entry);
				switch (message.role) {
					case "user":
						taskCutPending = false;
						entries.push(logEntry(entry.id, "user", time, textOf(message.content)));
						break;
					case "assistant": {
						const toolCalls = toolCallsOf(message.content);
						for (const call of toolCalls) if (call.id !== "") calls.set(call.id, call);
						entries.push(
							logEntry(entry.id, "assistant", time, textOf(message.content), {
								toolCalls,
								thinking: thinkingOf(message.content),
							}),
						);
						if (typeof message.provider === "string" && typeof message.model === "string") {
							lastModelKey = `${message.provider}/${message.model}`;
						}
						// The entry is written when the response ends, so this overestimates how warm the cache
						// is. That can only skip a free cut; it never adds a cache break.
						touch(Date.parse(entry.timestamp));
						break;
					}
					case "toolResult": {
						const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
						const isError = message.isError === true;
						const call = typeof message.toolCallId === "string" ? calls.get(message.toolCallId) : undefined;
						entries.push(
							logEntry(entry.id, "tool", time, textOf(message.content), {
								toolName,
								isError,
								...(call ? { call } : {}),
							}),
						);
						// Sessions written before NOTEBOOK_KIND kept the notebook in the tool result.
						const details = message.details as { text?: unknown } | undefined;
						if (toolName === TOOLS.notebook.name && !isError && typeof details?.text === "string") {
							notebook = details.text;
							notebookCurrent = true;
						}
						break;
					}
					case "bashExecution":
						if (message.excludeFromContext !== true) {
							const command = typeof message.command === "string" ? message.command : "";
							const output = typeof message.output === "string" ? message.output : "";
							const text = `$ ${command}\n${output}`;
							entries.push(logEntry(entry.id, "custom", time, text));
						}
						break;
					case "custom":
						entries.push(logEntry(entry.id, "custom", time, textOf(message.content)));
						break;
					default:
						break;
				}
				break;
			}
			case "custom_message":
				if (entry.customType === REMINDER_KIND) reminded = true;
				entries.push(logEntry(entry.id, "custom", Date.parse(entry.timestamp), textOf(entry.content)));
				break;
			case "branch_summary":
				entries.push(logEntry(entry.id, "custom", Date.parse(entry.timestamp), entry.summary));
				break;
			case "compaction": {
				minKeptIndex = entries.length;
				compactionKeptId = entry.firstKeptEntryId;
				compactionTokens = estimateTokens(entry.summary);
				taskCutPending = false;
				notebookCurrent = false;
				reminded = false;
				const details = entry.details as { sandyContext?: unknown } | undefined;
				if (details?.sandyContext !== undefined) cuts++;
				else {
					foreignKeptId = entry.firstKeptEntryId;
					foreignIndex = entries.length;
				}
				break;
			}
			case "custom":
				if (entry.customType === SUMMARY_KIND) summary = readSummaryState(entry.data) ?? summary;
				if (entry.customType === TASK_DONE_KIND) taskCutPending = true;
				if (entry.customType === NOTEBOOK_KIND) {
					const text = (entry.data as { text?: unknown } | undefined)?.text;
					if (typeof text === "string") {
						notebook = text;
						notebookCurrent = true;
					}
				}
				break;
			case "usage":
				if (entry.kind === "cache_warm") touch(Date.parse(entry.timestamp));
				break;
			default:
				break;
		}
	}

	const keptIndex = compactionKeptId === undefined ? -1 : entries.findIndex((entry) => entry.id === compactionKeptId);
	const foreignKeptIndex = foreignKeptId === undefined ? -1 : entries.findIndex((entry) => entry.id === foreignKeptId);
	const visibleFromIndex = compactionKeptId === undefined ? 0 : keptIndex >= 0 ? keptIndex : minKeptIndex;
	return {
		entries,
		minKeptIndex,
		visibleFromIndex,
		visibleTokens: entries.slice(visibleFromIndex).reduce((sum, entry) => sum + entry.tokens, compactionTokens),
		historianFloorIndex: foreignKeptId === undefined ? 0 : foreignKeptIndex >= 0 ? foreignKeptIndex : foreignIndex,
		summary,
		notebook,
		notebookCurrent,
		reminded,
		lastModelKey,
		lastCacheTouch,
		endsWithCompaction: branch.at(-1)?.type === "compaction",
		cuts,
		taskCutPending,
	};
}

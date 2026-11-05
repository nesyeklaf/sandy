/*
 * Raw session entries as pi writes them, for the accounting and retrieval tests. Costs are whole numbers so totals are exact.
 */
import { ATTEMPT_KIND, KEEP_WARM_KIND, RETRIEVAL_KIND, SUMMARY_KIND, WARMING_KIND } from "../../src/core/kinds.ts";

export type RawEntry = Record<string, unknown> & { type: string };

let counter = 0;
const nextId = () => "e" + String(++counter).padStart(4, "0");

/** pi-ai's usage shape with a catalogue cost. */
export const piUsage = (cost: number, input = 10, output = 5, cacheRead = 0, cacheWrite = 0) => ({
	input,
	output,
	cacheRead,
	cacheWrite,
	totalTokens: input + output + cacheRead + cacheWrite,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

export const user = (text = "hi"): RawEntry => ({ type: "message", id: nextId(), message: { role: "user", content: [{ type: "text", text }] } });

export const assistant = (cost: number, tokens: { input?: number; cacheRead?: number; output?: number } = {}, content: unknown[] = [{ type: "text", text: "ok" }], id = nextId()): RawEntry => ({
	type: "message",
	id,
	message: { role: "assistant", content, usage: piUsage(cost, tokens.input ?? 10, tokens.output ?? 5, tokens.cacheRead ?? 0), stopReason: "stop" },
});

export const toolCall = (callId: string, name: string, args: Record<string, unknown>, tokens: { input?: number; cacheRead?: number; output?: number } = {}): RawEntry =>
	assistant(0, { input: 0, output: 0, ...tokens }, [{ type: "toolCall", id: callId, name, arguments: args }]);

export const toolResult = (callId: string, name: string, details?: unknown, usage?: unknown): RawEntry => ({
	type: "message",
	id: nextId(),
	message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: "result" }], ...(details !== undefined ? { details } : {}), ...(usage !== undefined ? { usage } : {}), isError: false },
});

export const totals = (cost: number, input = 10, output = 5, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite, cost });

const attemptStart = (id: string, step: "summarize" | "condense", route: string, model = "m/historian"): RawEntry => ({
	type: "custom",
	id: nextId(),
	customType: ATTEMPT_KIND,
	data: { type: "start", id, key: "work-1", at: 1, throughId: "x", cohort: 1, step, model, route },
});

const attemptEnd = (id: string, outcome: string, step: "summarize" | "condense", usage?: unknown): RawEntry => ({
	type: "custom",
	id: nextId(),
	customType: ATTEMPT_KIND,
	data: { type: "end", id, key: "work-1", at: 2, outcome, step, ...(usage !== undefined ? { usage } : {}) },
});

/** One historian request: its start, and its end unless `end` is false. */
export function attempt(id: string, outcome: string | false, usage?: unknown, step: "summarize" | "condense" = "summarize", route = "primary"): RawEntry[] {
	return [attemptStart(id, step, route), ...(outcome === false ? [] : [attemptEnd(id, outcome, step, usage)])];
}

export const ping = (): RawEntry => ({ type: "custom_message", id: nextId(), customType: KEEP_WARM_KIND, content: "ping", display: false });

/** One keep-warm side request: its start record, and its end record unless `outcome` is false. */
export function sideWarm(id: string, outcome: string | false, usage?: unknown): RawEntry[] {
	const entry = (data: Record<string, unknown>): RawEntry => ({ type: "custom", id: nextId(), customType: KEEP_WARM_KIND, data });
	return [
		entry({ type: "start", id, at: 1, model: "p/m" }),
		...(outcome === false ? [] : [entry({ type: "end", id, at: 1, outcome, ...(usage !== undefined ? { usage } : {}) })]),
	];
}

export const warming = (data: Record<string, unknown>): RawEntry => ({ type: "custom", id: nextId(), customType: WARMING_KIND, data });
export const warmUsage = (cost: number, note?: string): RawEntry => ({ type: "usage", id: nextId(), kind: "cache_warm", provider: "p", model: "m", usage: piUsage(cost), ...(note ? { note } : {}) });

export const compaction = (opts: { usage?: unknown; fromHook?: boolean; ours?: boolean } = {}): RawEntry => ({
	type: "compaction",
	id: nextId(),
	summary: opts.ours ? '<context reason="watermark">\nsummary' : "Summary by pi",
	firstKeptEntryId: "x",
	tokensBefore: 1000,
	...(opts.ours ? { details: { context: { version: 1, reason: "watermark", keptFromId: "x", archivedEntries: 0, blockTokens: 0 } } } : {}),
	...(opts.usage !== undefined ? { usage: opts.usage } : {}),
	...(opts.fromHook !== undefined ? { fromHook: opts.fromHook } : {}),
});

export const branchSummary = (usage?: unknown): RawEntry => ({ type: "branch_summary", id: nextId(), fromId: "x", summary: "s", ...(usage !== undefined ? { usage } : {}) });

export const retrieval = (data: Record<string, unknown>): RawEntry => ({ type: "custom", id: nextId(), customType: RETRIEVAL_KIND, data });

/**
 * A stored historian summary as the historian writes it: the usage of the requests behind it on the record. The
 * historian before attempt receipts wrote this and nothing else; `customType` names the pre-rename kind when asked.
 */
export const summaryRecord = (usage?: unknown, condenseUsage?: unknown, customType = SUMMARY_KIND): RawEntry => ({
	type: "custom",
	id: nextId(),
	customType,
	data: {
		version: 1,
		coveredThroughId: "x",
		sections: { goal: [], state: ["- state (#x)"], chapters: [], decisions: [], facts: [], errors: [], next: [] },
		...(usage !== undefined ? { usage } : {}),
		...(condenseUsage !== undefined ? { condenseUsage } : {}),
	},
});

import { TOOLS } from "./tools.ts";
import type { LogEntry } from "./types.ts";

/**
 * Mechanical signals about how a session uses its context, counted from tool results and written to the ledger with
 * every request. They measure the cut policy, they do not drive it:
 * - tool output: how much the tools put into the prompt, per request and per run, the load delegation would take off
 * - delegations: runs handed to other agents (sandy workflows, sandy threads)
 * - after a cut: history_search and history_read calls and re-reads of files the cut archived, the agent looking for
 *   what the cut took away
 */
export interface ToolObservation {
	readonly name: string;
	readonly input: Record<string, unknown>;
	/** Tokens the result adds to the prompt; 0 for a call made inside another tool, whose result the model never sees. */
	readonly outputTokens: number;
}

export interface SignalSnapshot {
	/** Tool output tokens since the previous request. */
	readonly toolTokens: number;
	/** Tool output tokens since the run started. */
	readonly runToolTokens: number;
	/** Agents started through sandy in this run. */
	readonly delegations: number;
	/** Requests since the latest cut this process saw; undefined before the first one. */
	readonly requestsSinceCut: number | undefined;
	readonly historyCallsSinceCut: number;
	readonly rereadsSinceCut: number;
}

/** What the engine publishes on `SIGNALS_CHANNEL` after every turn. */
export interface ContextSignalsEvent extends SignalSnapshot {
	readonly sessionId: string;
	readonly contextTokens: number | undefined;
	readonly soft: number;
	readonly hard: number;
}

const HISTORY_TOOLS = new Set<string>([TOOLS.historySearch.name, TOOLS.historyRead.name]);
const READ_TOOLS = new Set(["read"]);
const DELEGATION = /\bsandy\s+(?:workflows(?:-plus)?\s+run|thread\s+(?:new|create|spawn|fork|tell))\b/;

/** The file a read call reads, when it is one. */
export function readPath(name: string, input: unknown): string | undefined {
	if (!READ_TOOLS.has(name.toLowerCase())) return undefined;
	const path = (input as { path?: unknown } | undefined)?.path;
	return typeof path === "string" && path !== "" ? path : undefined;
}

/** Whether a call starts another agent through sandy: a sandy workflow tool, or a sandy command that runs one. */
export function isDelegation(name: string, input: Record<string, unknown>): boolean {
	if (/workflow.*_run$/.test(name)) return true;
	const command = input.command ?? input.cmd;
	return typeof command === "string" && DELEGATION.test(command);
}

/** Files read in the archived part of the log, the part before `visibleFromIndex`. */
export function archivedReads(entries: readonly LogEntry[], visibleFromIndex: number): Set<string> {
	const paths = new Set<string>();
	for (const entry of entries.slice(0, visibleFromIndex)) {
		if (entry.kind !== "tool" || !entry.call) continue;
		const path = readPath(entry.call.name, entry.call.args);
		if (path) paths.add(path);
	}
	return paths;
}

export class ContextSignals {
	private toolTokens = 0;
	private runToolTokens = 0;
	private delegations = 0;
	private requestsSinceCut: number | undefined;
	private historyCalls = 0;
	private rereads = 0;

	startRun(): void {
		this.runToolTokens = 0;
		this.delegations = 0;
	}

	/** A cut was accepted by the provider: the after-cut counters start over. */
	cut(): void {
		this.requestsSinceCut = 0;
		this.historyCalls = 0;
		this.rereads = 0;
	}

	/**
	 * Pick up the after-cut counters of a branch cut before this process started: SANDY keeps a pi process loaded for
	 * hours, but a reload or restart starts a fresh one in the middle of a branch. Only the calls in the log count;
	 * calls made inside another tool left no entry.
	 */
	resume(entries: readonly LogEntry[], minKeptIndex: number, visibleFromIndex: number): void {
		this.cut();
		const archived = archivedReads(entries, visibleFromIndex);
		let requests = 0;
		for (const entry of entries.slice(minKeptIndex)) {
			if (entry.kind === "assistant") requests++;
			if (entry.kind !== "tool" || !entry.call) continue;
			if (HISTORY_TOOLS.has(entry.call.name)) this.historyCalls++;
			const path = readPath(entry.call.name, entry.call.args);
			if (path && archived.has(path)) this.rereads++;
		}
		this.requestsSinceCut = requests;
	}

	/** One tool result; `archived` tells whether a read file was read before the latest cut. */
	observe(tool: ToolObservation, archived: (path: string) => boolean): void {
		this.toolTokens += tool.outputTokens;
		this.runToolTokens += tool.outputTokens;
		if (isDelegation(tool.name, tool.input)) this.delegations++;
		if (this.requestsSinceCut === undefined) return;
		if (HISTORY_TOOLS.has(tool.name)) this.historyCalls++;
		const path = readPath(tool.name, tool.input);
		if (path && archived(path)) this.rereads++;
	}

	/** The signals for the request about to be recorded; the per-request count starts over. */
	request(): SignalSnapshot {
		const snapshot = this.snapshot();
		this.toolTokens = 0;
		if (this.requestsSinceCut !== undefined) this.requestsSinceCut++;
		return snapshot;
	}

	snapshot(): SignalSnapshot {
		return {
			toolTokens: this.toolTokens,
			runToolTokens: this.runToolTokens,
			delegations: this.delegations,
			requestsSinceCut: this.requestsSinceCut,
			historyCallsSinceCut: this.historyCalls,
			rereadsSinceCut: this.rereads,
		};
	}
}

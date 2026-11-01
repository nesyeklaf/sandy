import type { ExtensionAPI, ExtensionContext, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { ContextConfig } from "../../src/core/config.ts";
import { CutController } from "../../src/pi/cuts.ts";
import { sessionLog } from "./session-log.ts";
import { piSdk } from "./pi.ts";

/*
 * The cut controller against pi's own SessionManager and projector, with the context a turn boundary hands it.
 */

export type Log = ReturnType<typeof sessionLog>;

/** A controller on `log`; `turnEnd` returns the drafts it adds at a boundary, `beforeCompact` what it answers pi's compaction. */
export function boundaryHarness(log: Log, config: ContextConfig, tokens = 5_000, capEvidence: (ctx: ExtensionContext) => string | undefined = () => undefined) {
	const ctx = {
		sessionManager: log.manager,
		model: { provider: "faux", id: "faux-1", contextWindow: 200_000 },
		hasUI: false,
		hasPendingMessages: () => false,
		isIdle: () => true,
		getSystemPrompt: () => "You are a coding agent.",
		getContextUsage: () => ({ tokens, contextWindow: 200_000, percent: null }),
		compact: () => {},
	} as unknown as ExtensionContext;
	const appended: { customType: string; data: unknown }[] = [];
	const pi = {
		getSettings: () => ({}),
		getActiveTools: () => ["read"],
		getAllTools: () => [{ name: "read", description: "Read a file.", parameters: { type: "object" } }],
		appendEntry: (customType: string, data: unknown) => void appended.push({ customType, data }),
	} as unknown as ExtensionAPI;
	const cuts = new CutController({
		config,
		pi,
		project: piSdk.buildSessionProjection as never,
		now: () => Date.UTC(2026, 9, 9, 12, 0, 0),
		tier: () => "short",
		ledger: () => {},
		report: () => {},
		notebookAvailable: () => false,
		competing: () => false,
		capEvidence,
	});
	cuts.start(ctx);
	/** One turn_end whose tool results are the logged results of the given calls; the drafts of the handler are returned. */
	const turnEnd = (calls: string[], size = tokens, entries: unknown[] = []): SessionBoundaryDraft[] => {
		const results = new Map<string, unknown>();
		for (const entry of log.manager.getEntries()) {
			const message = entry.type === "message" ? (entry.message as { role: string; toolCallId?: string }) : undefined;
			if (message?.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, message);
		}
		const event = {
			type: "turn_end",
			outcome: "completed",
			entries,
			toolResults: calls.map((toolCallId) => results.get(toolCallId) ?? { toolCallId }),
			context: { llmMessages: [] },
		} as never;
		return (cuts.finishTurn(event, ctx, size, cuts.thresholds(ctx))?.entries ?? []).slice(entries.length);
	};
	/** pi's compaction of `reason` (threshold, overflow, manual) at `size` tokens; undefined when we leave it to pi. */
	const beforeCompact = (reason: "threshold" | "overflow" | "manual", size = tokens) =>
		cuts.beforeCompact(
			{ type: "session_before_compact", reason, preparation: { tokensBefore: size }, branchEntries: log.manager.getBranch() } as never,
			ctx,
		);
	return { turnEnd, beforeCompact, appended };
}

/** Commits drafts as pi does at a boundary. */
export function commitDrafts(log: Log, drafts: readonly SessionBoundaryDraft[]): void {
	for (const draft of drafts) {
		if (draft.type === "context_edit") log.manager.appendContextEdit(draft.targetId, draft.replacement);
		else if (draft.type === "custom") log.manager.appendCustomEntry(draft.customType, draft.data);
		else if (draft.type === "compaction") {
			log.manager.appendCompaction(draft.summary, draft.firstKeptEntryId as string, 0, draft.details, true);
		}
	}
}

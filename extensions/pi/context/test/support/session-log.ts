import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { CUT_DETAILS_KEY, SUMMARY_KIND } from "../../src/core/kinds.ts";
import { emptySections, type SummaryState } from "../../src/core/summary.ts";
import { SessionTape, type StoredLimits } from "../../src/pi/session.ts";
import { piSdk } from "./pi.ts";

export type Manager = ReturnType<typeof piSdk.SessionManager.inMemory>;

let clock = Date.UTC(2026, 9, 9, 12, 0, 0);
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const cutDetails = (keptFromId: string) => ({
	version: 1,
	reason: "watermark",
	keptFromId,
	archivedEntries: 0,
	blockTokens: 0,
});

/** A session written through pi's SessionManager, read back through the tape. */
export function sessionLog(manager: Manager = piSdk.SessionManager.inMemory()) {
	const assistant = (content: unknown[], stopReason: string) =>
		manager.appendMessage({
			role: "assistant",
			content,
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage,
			stopReason,
			timestamp: ++clock,
		} as never);
	const log = {
		manager,
		user: (text: string) => manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: ++clock }),
		call: (callId: string, name: string, args: Record<string, unknown>) =>
			assistant([{ type: "toolCall", id: callId, name, arguments: args }], "toolUse"),
		result: (callId: string, name: string, text: string, details?: unknown) =>
			manager.appendMessage({
				role: "toolResult",
				toolCallId: callId,
				toolName: name,
				content: [{ type: "text", text }],
				...(details !== undefined ? { details } : {}),
				isError: false,
				timestamp: ++clock,
			} as never),
		answer: (text: string, thinking?: string) =>
			assistant([...(thinking ? [{ type: "thinking", thinking }] : []), { type: "text", text }], "stop"),
		/** One turn: a prompt, a read and its result, an answer. */
		turn: (label: string, resultChars = 2_000) => {
			const user = log.user("Please look at module-" + label + ".");
			const call = log.call("c-" + label, "read", { path: "src/" + label + ".ts" });
			const result = log.result("c-" + label, "read", "FACT " + label + " holds.\n" + "x".repeat(resultChars));
			const answer = log.answer("Module " + label + " is fine.");
			return { user, call, result, answer };
		},
		/** One turn without tools: a prompt and a long answer, text the historian sees whole and not clipped. */
		talk: (label: string, answerChars = 2_000) => {
			const user = log.user("Please explain module-" + label + ".");
			const answer = log.answer("FACT " + label + " holds.\n" + "y".repeat(answerChars));
			return { user, answer };
		},
		replace: (targetId: string, text: string) =>
			manager.appendContextEdit(targetId, { content: [{ type: "text", text }] }),
		omit: (targetId: string) => manager.appendContextEdit(targetId, null),
		ownCut: (keptId: string, text = '<context reason="watermark">cut</context>') =>
			manager.appendCompaction(text, keptId, 0, { [CUT_DETAILS_KEY]: cutDetails(keptId) }, true),
		foreign: (keptId: string, text: string, details?: unknown) => manager.appendCompaction(text, keptId, 0, details, false),
		/** A summary; `projectedThroughId` marks one the historian made from the projection read at that entry. */
		summary: (coveredThroughId: string, goal: string, projectedThroughId?: string) => {
			const state: SummaryState = { version: 1, coveredThroughId, sections: { ...emptySections(), goal: [goal] } };
			return manager.appendCustomEntry(SUMMARY_KIND, { ...state, ...(projectedThroughId ? { projectedThroughId } : {}) });
		},
		tape: (limits: StoredLimits = DEFAULT_CONFIG) => SessionTape.read(manager.getBranch(), piSdk.buildSessionProjection, limits),
	};
	return log;
}

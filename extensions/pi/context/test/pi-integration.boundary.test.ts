import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { createContextExtension } from "../src/pi/extension.ts";
import { seededManager, tempDir } from "./support/lifecycle.ts";
import { piAi, piSdk } from "./support/pi.ts";

/*
 * A cut at a run boundary in pi's real runtime, after another extension's turn_end handler replaced every user message
 * with a context_edit draft. pi commits those drafts together with ours, so the cut must be planned from the branch as
 * it will be, edits included, not from the entries persisted before the boundary.
 */

const VERSION = piSdk.VERSION;
const REPLACEMENT = "UPDATED-INSTRUCTION";

describe("cuts at a run boundary in the pi runtime " + VERSION, () => {
	it("plans the cut from the edits earlier boundary handlers made", async () => {
		const dir = tempDir();
		const manager = seededManager(dir, 40);
		const users = manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "user");
		const faux = piAi.registerFauxProvider({ models: [{ id: "faux-main", reasoning: false, contextWindow: 200_000, maxTokens: 4_096 }] });
		faux.setResponses([
			() => {
				const message = piAi.fauxAssistantMessage("ok") as { usage: { input: number; totalTokens: number } };
				message.usage.input = 25_000;
				message.usage.totalTokens = 25_000;
				return message;
			},
		]);
		const model = faux.getModel();
		const editor = (pi: ExtensionAPI) => {
			pi.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				apiKey: "faux-key",
				api: faux.api as never,
				models: faux.models.map(({ id, name, reasoning, input, cost, contextWindow, maxTokens }) => ({
					id,
					name,
					reasoning,
					input,
					cost,
					contextWindow,
					maxTokens,
				})),
			});
			pi.on("turn_end", () => ({
				entries: users.map((entry) => ({
					type: "context_edit" as const,
					targetId: entry.id,
					replacement: { content: [{ type: "text" as const, text: REPLACEMENT }] },
				})),
			}));
		};
		const context = createContextExtension({
			configFile: false,
			ledgerFile: join(dir, "ledger.jsonl"),
			keepWarm: false,
			config: {
				watermarkTokens: 20_000,
				keepRecentTokens: 1_000,
				maskedTokens: 500,
				pinnedUserTokens: 300,
				summaryTokens: 400,
				historian: { enabled: false },
			},
		});
		const runtime = await piSdk.createAgentSessionRuntime(
			async ({ cwd, sessionManager, sessionStartEvent }) => {
				const services = await piSdk.createAgentSessionServices({
					cwd,
					agentDir: dir,
					resourceLoaderOptions: {
						extensionFactories: [editor, context],
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
					},
				});
				const made = await piSdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: model as never });
				return { ...made, services, diagnostics: services.diagnostics };
			},
			{ cwd: dir, agentDir: dir, sessionManager: manager },
		);
		try {
			await runtime.session.bindExtensions({});
			await runtime.session.prompt("next");
			const branch = manager.getBranch();
			const cuts = branch.filter((entry): entry is Extract<SessionEntry, { type: "compaction" }> => entry.type === "compaction");
			assert.equal(branch.filter((entry) => entry.type === "context_edit").length, users.length);
			assert.equal(cuts.length, 1);
			const summary = cuts[0]!.summary;
			assert.ok(summary.includes(REPLACEMENT), "the cut carries the replaced user messages");
			assert.ok(!summary.includes("Question "), "the cut carries none of the text the edits replaced");
		} finally {
			await runtime.dispose();
			faux.unregister();
		}
	});
});

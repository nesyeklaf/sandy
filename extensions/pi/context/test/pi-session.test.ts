import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { openArchive } from "../src/core/archive.ts";
import { DEFAULT_CONFIG, resolveConfig } from "../src/core/config.ts";
import { foldCut } from "../src/core/cut.ts";
import { evidenceBudget, historianPrompt, selectEvidence } from "../src/core/historian.ts";
import { CUT_DETAILS_KEY, KEEP_WARM_KIND, NOTEBOOK_KIND, TASK_DONE_KIND } from "../src/core/kinds.ts";
import { condensePrompt } from "../src/core/historian.ts";
import { condenseSelection, emptySections } from "../src/core/summary.ts";
import type { ArchiveReader, EffectiveHistory, ModelView } from "../src/core/types.ts";
import { SessionTape } from "../src/pi/session.ts";
import { harness, storedSummaries } from "./support/historian.ts";
import { openRuntime } from "./support/lifecycle.ts";
import { type FauxContext, piAi, piSdk } from "./support/pi.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * The session reader against pi's own SessionManager and projector: what the model sees follows context_edit, the
 * history behind our own cuts stays reachable with the same edits, and the archive keeps every original.
 */

const VERSION = piSdk.VERSION;
const OBSOLETE = "OBSOLETE-INSTRUCTION: deploy to production after every commit";
const config = resolveConfig({
	keepRecentTokens: 1_000,
	maskedTokens: 500,
	pinnedUserTokens: 1_000,
	historian: { chunkMinTokens: 100, chunkMaxTokens: 40_000 },
});

const textIn = (entries: readonly { readonly id: string; readonly text: string }[], id: string) =>
	entries.find((entry) => entry.id === id)?.text;
const ids = (entries: readonly { readonly id: string }[]) => entries.map((entry) => entry.id);
const statusOf = (archive: ArchiveReader, id: string) => archive.entries.find((entry) => entry.id === id)?.status;
const planFrom = (history: EffectiveHistory, competing = false) =>
	foldCut({
		competing,
		checkpointSuperseded: history.checkpointSuperseded,
		config,
		reason: "watermark",
		entries: history.entries,
		minKeptIndex: history.minKeptIndex,
		visibleFromIndex: history.visibleFromIndex,
		summary: history.summary,
		checkpoint: history.checkpoint,
		notebook: history.notebook,
	});
const historianInput = (history: EffectiveHistory) => {
	const work = selectEvidence(history, evidenceBudget(config, false));
	return work ? historianPrompt(work) : "";
};

describe("the session tape on pi " + VERSION + ": edits", () => {
	it("shows a replacement in the model view and the history, and keeps the original in the archive", () => {
		const log = sessionLog();
		const first = log.turn("a");
		log.turn("b");
		log.replace(first.result, "read result withdrawn");
		const tape = log.tape();
		assert.equal(textIn(tape.modelView().entries, first.result), "read result withdrawn");
		assert.equal(textIn(tape.history().entries, first.result), "read result withdrawn");
		assert.match(textIn(tape.archive().entries, first.result) ?? "", /FACT a holds/);
		assert.equal(statusOf(tape.archive(), first.result), "replaced");
		assert.equal(statusOf(tape.archive(), first.user), "visible");
	});

	it("drops an omitted entry from both views and keeps it in the archive", () => {
		const log = sessionLog();
		const first = log.turn("a");
		log.turn("b");
		log.omit(first.result);
		const tape = log.tape();
		assert.ok(!ids(tape.modelView().entries).includes(first.result));
		assert.ok(!ids(tape.history().entries).includes(first.result));
		assert.equal(statusOf(tape.archive(), first.result), "omitted");
		assert.match(textIn(tape.archive().entries, first.result) ?? "", /FACT a holds/);
	});

	it("marks a same-size edit of a tool call or of thinking as replaced", () => {
		const log = sessionLog();
		const call = log.call("c-path", "read", { path: "src/old.ts" });
		log.result("c-path", "read", "contents");
		const thought = log.answer("done", "think A");
		log.manager.appendContextEdit(call, {
			content: [{ type: "toolCall", id: "c-path", name: "read", arguments: { path: "src/new.ts" } }],
		} as never);
		log.manager.appendContextEdit(thought, {
			content: [
				{ type: "thinking", thinking: "think B" },
				{ type: "text", text: "done" },
			],
		} as never);
		const archive = log.tape().archive();
		assert.equal(statusOf(archive, call), "replaced");
		assert.equal(statusOf(archive, thought), "replaced");
	});

	it("applies the last edit of an entry", () => {
		const log = sessionLog();
		const first = log.turn("a");
		log.replace(first.result, "first replacement");
		log.replace(first.result, "second replacement");
		assert.equal(textIn(log.tape().modelView().entries, first.result), "second replacement");
		assert.equal(textIn(log.tape().history().entries, first.result), "second replacement");
		log.omit(first.result);
		log.replace(first.result, "back again");
		assert.equal(textIn(log.tape().modelView().entries, first.result), "back again");
		assert.equal(statusOf(log.tape().archive(), first.result), "replaced");
	});

	it("never lets an edited-away instruction into a cut or the historian, while the archive still reads it", async () => {
		const log = sessionLog();
		const instruction = log.user(OBSOLETE);
		log.answer("Will do.");
		for (const label of ["a", "b", "c", "d", "e"]) log.turn(label);
		log.replace(instruction, "(instruction withdrawn by the user)");
		const tape = log.tape();
		const plan = planFrom(tape.history());
		assert.ok(plan, "a cut is planned");
		assert.ok(!plan.text.includes("OBSOLETE"), "the cut carries the edited-away instruction");
		assert.match(plan.text, /instruction withdrawn by the user/);
		const prompt = historianInput(tape.history());
		assert.match(prompt, /instruction withdrawn/);
		assert.ok(!prompt.includes("OBSOLETE"), "the historian reads the edited-away instruction");
		assert.equal(statusOf(tape.archive(), instruction), "replaced");
		const original = await tape.archive().read({ id: instruction });
		assert.match(original.text, /OBSOLETE-INSTRUCTION/);
		assert.match(original.text, /ever follow it as current guidance/);

		// The same after our cut: the history behind it still carries the replacement, never the original.
		const kept = log.user("Next task.");
		log.ownCut(kept, plan.text);
		log.turn("f");
		const after = log.tape();
		assert.ok(!planFrom(after.history())?.text.includes("OBSOLETE"));
		assert.ok(!historianInput(after.history()).includes("OBSOLETE"));
		assert.equal(statusOf(after.archive(), instruction), "replaced");
	});
});

describe("the session tape on pi " + VERSION + ": cuts and compactions", () => {
	it("keeps the history behind repeated own cuts reachable, with edits made before them", () => {
		const log = sessionLog();
		const turns = ["0", "1", "2", "3", "4", "5"].map((label) => log.turn(label));
		const [t0, , t2, , t4] = turns;
		assert.ok(t0 && t2 && t4);
		log.replace(t0.result, "REPLACED-T0");
		log.ownCut(t2.user, '<context reason="watermark">first cut</context>');
		log.turn("6");
		const second = log.ownCut(t4.user, '<context reason="watermark">second cut</context>');
		const t7 = log.turn("7");
		const tape = log.tape();

		const view = tape.modelView();
		assert.deepEqual(view.checkpoint, {
			id: second,
			owner: "own",
			text: '<context reason="watermark">second cut</context>',
			status: "current",
		});
		assert.equal(view.entries[0]?.id, t4.user);
		assert.ok(!ids(view.entries).includes(t0.result));

		const history = tape.history();
		assert.equal(history.checkpoint, undefined);
		assert.equal(history.entries[0]?.id, t0.user, "own cuts are see-through");
		assert.equal(textIn(history.entries, t0.result), "REPLACED-T0");
		assert.ok(!history.entries.some((entry) => entry.text.includes("FACT 0 holds")));
		assert.equal(history.visibleFromIndex, ids(history.entries).indexOf(t4.user));
		assert.equal(history.minKeptIndex, ids(history.entries).indexOf(t7.user));

		// A result replaced before our first cut reaches the historian after the second; the original does not.
		const prompt = historianInput(history);
		assert.match(prompt, /REPLACED-T0/);
		assert.ok(!prompt.includes("FACT 0 holds"));

		const archive = tape.archive();
		assert.equal(statusOf(archive, t0.result), "replaced");
		assert.equal(statusOf(archive, t0.user), "archived");
		assert.equal(statusOf(archive, t4.user), "visible");
		assert.equal(tape.state.cuts, 2);
	});

	it("carries a foreign compaction's summary verbatim in both views", () => {
		const log = sessionLog();
		const turns = ["0", "1", "2", "3"].map((label) => log.turn(label));
		const [t0, , t2] = turns;
		assert.ok(t0 && t2);
		const text = "FOREIGN-SUMMARY of pi's own compaction\n- kept verbatim, including this line";
		const compaction = log.foreign(t2.user, text);
		log.turn("4");
		const tape = log.tape();
		const checkpoint = { id: compaction, owner: "foreign", text, status: "current" };
		assert.deepEqual(tape.modelView().checkpoint, checkpoint);
		assert.deepEqual(tape.history().checkpoint, checkpoint);
		assert.equal(tape.history().entries[0]?.id, t2.user, "what the foreign compaction archived stays out of the history");
		assert.equal(statusOf(tape.archive(), t0.user), "archived");
		assert.ok(tape.modelView().tokens >= Math.ceil(text.length / 4));

		// Our cut replaces it in the model view; the history still carries it, verbatim.
		const t5 = log.turn("5");
		log.ownCut(t5.user);
		const after = log.tape();
		assert.equal(after.modelView().checkpoint?.owner, "own");
		assert.deepEqual(after.history().checkpoint, checkpoint);
		assert.equal(after.history().entries[0]?.id, t2.user);
	});

	it("reads our own and a foreign compaction from the archive with the entries each one newly covers", async () => {
		const log = sessionLog();
		const [t0, t1, t2, t3] = ["0", "1", "2", "3"].map((label) => log.turn(label));
		assert.ok(t0 && t1 && t2 && t3);
		const foreign = log.foreign(t2.user, "FOREIGN-SUMMARY of pi's own compaction");
		log.turn("4");
		const own = log.ownCut(t3.user, '<context reason="watermark">OWN-SUMMARY</context>');
		const archive = log.tape().archive();
		const first = await archive.read({ id: foreign });
		assert.match(first.text, /FOREIGN-SUMMARY/);
		assert.match(first.text, new RegExp("covers 8 entries, #" + t0.user + " through #" + t1.answer));
		const second = await archive.read({ id: own });
		assert.match(second.text, /OWN-SUMMARY/);
		assert.match(second.text, new RegExp("covers \\d+ entries, #" + t2.user));
		assert.match(second.text, new RegExp("builds on the summary of #" + foreign));
		assert.deepEqual((await archive.search({ query: "#" + foreign + " #" + own })).hits, [foreign, own]);
		assert.ok(!archive.entries.some((entry) => entry.id === own), "a compaction is an item, not an entry");
	});

	it("keeps an earlier foreign compaction readable and searchable after later foreign and own cuts", async () => {
		const log = sessionLog();
		const [t0, t1, t2, t3, t4, t5] = ["0", "1", "2", "3", "4", "5"].map((label) => log.turn(label));
		assert.ok(t0 && t1 && t2 && t3 && t4 && t5);
		const foreignA = log.foreign(t1.user, "FOREIGN-A-SUMMARY alphaword");
		log.ownCut(t2.user);
		const foreignB = log.foreign(t4.user, "FOREIGN-B-SUMMARY betaword");
		log.ownCut(t5.user);
		const tape = log.tape();
		assert.equal(tape.history().checkpoint?.id, foreignB, "history carries only the latest foreign checkpoint");
		const archive = tape.archive();
		const read = await archive.read({ id: foreignA });
		assert.equal(read.status, "compaction");
		assert.match(read.text, /FOREIGN-A-SUMMARY alphaword/);
		assert.match(read.text, new RegExp("covers \\d+ entries, #" + t0.user));
		assert.deepEqual((await archive.search({ query: "#" + foreignA })).hits, [foreignA]);
		assert.ok((await archive.search({ query: "FACT 0 holds" })).hits.includes(t0.result), "the entries A covers stay searchable");
		assert.match((await archive.read({ id: foreignB })).text, new RegExp("builds on the summary of #"));
	});

	it("finds a word only a foreign or an own compaction summary holds, and keeps it from the model's own cut text", async () => {
		const log = sessionLog();
		const [t0, , t2, t3] = ["0", "1", "2", "3"].map((label) => log.turn(label));
		assert.ok(t0 && t2 && t3);
		const foreign = log.foreign(t2.user, "FOREIGN-SUMMARY: ONLYFOREIGNQUUX was decided");
		log.turn("4");
		const own = log.ownCut(t3.user, '<context reason="watermark">OWN-SUMMARY: ONLYOWNQUUX holds</context>');
		const archive = log.tape().archive();
		const foreignFound = await archive.search({ query: "ONLYFOREIGNQUUX" });
		assert.deepEqual(foreignFound.hits, [foreign]);
		assert.match(foreignFound.text, /ONLYFOREIGNQUUX was decided/);
		assert.deepEqual((await archive.search({ query: "ONLYOWNQUUX" })).hits, [own]);
		assert.deepEqual((await archive.search({ query: "ONLYOWNQUUX", includeVisible: true })).hits, [own]);
		assert.deepEqual((await archive.search({ query: "compaction covers builds" })).hits, [], "the summary's header and coverage lines are not indexed");
		const tuned = openArchive(archive.items, { chunk: 100, scanChars: 100, scanEntries: 1 });
		let cursor: string | undefined;
		const found: string[] = [];
		for (let pages = 0; pages < 100; pages++) {
			const page = await tuned.search({ query: "ONLYFOREIGNQUUX", ...(cursor ? { cursor } : {}) });
			found.push(...page.hits);
			cursor = page.cursor;
			if (!cursor) break;
		}
		assert.deepEqual(found, [foreign], "the cursor walks through the summary on the way back");
	});

	it("continues a search through a summary, a notebook and a later entry appended after its snapshot", async () => {
		const log = sessionLog();
		for (const label of ["a", "b", "c", "d"]) log.turn(label);
		log.ownCut(log.user("keep from here"));
		const before = log.tape().archive();
		const cursor = (await openArchive(before.items, { chunk: 100, scanChars: 100, scanEntries: 1 }).search({ query: "FACT" })).cursor;
		assert.ok(cursor);
		log.summary(log.user("another"), "goal");
		log.manager.appendCustomEntry(NOTEBOOK_KIND, { text: "note" });
		const next = await log.tape().archive().search({ query: "FACT", cursor });
		assert.ok(next.newer >= 1, "the entry appended since is counted");
		assert.ok(next.hits.length > 0, "and the search goes on");
	});

	it("keeps a foreign summary in what the model sees through our cuts", () => {
		const log = sessionLog();
		const [, t1] = ["0", "1", "2", "3"].map((label) => log.turn(label));
		assert.ok(t1);
		const text = "FOREIGN-SUMMARY of pi's own compaction\n- kept verbatim, including this line";
		log.foreign(t1.user, text);
		const cut = () => {
			for (const label of ["a", "b", "c", "d"]) log.turn(label + log.manager.getEntries().length);
			const plan = planFrom(log.tape().history());
			assert.ok(plan);
			log.manager.appendCompaction(plan.text, plan.firstKeptEntryId, 0, { [CUT_DETAILS_KEY]: plan.details }, true);
			const view = log.tape().modelView();
			assert.equal(view.checkpoint?.owner, "own");
			assert.ok(view.checkpoint.text.includes(text), "the cut text carries the foreign summary");
			const sent = view.messages[0] as { role?: string; summary?: string };
			assert.equal(sent.role, "compactionSummary");
			assert.ok(sent.summary?.includes(text), "the provider gets it");
		};
		cut();
		cut();
		assert.equal(log.tape().state.cuts, 2);
	});

	it("marks a foreign summary stale once an edit after it touches what it archived", () => {
		const log = sessionLog();
		const [t0, t1] = ["0", "1", "2"].map((label) => log.turn(label));
		assert.ok(t0 && t1);
		log.foreign(t1.user, "FOREIGN-SUMMARY");
		log.replace(t1.result, "edited, but kept verbatim");
		assert.equal(log.tape().history().checkpoint?.status, "current");
		log.replace(t0.result, "edited after the summary was written");
		assert.equal(log.tape().history().checkpoint?.status, "stale");
		assert.equal(log.tape().modelView().checkpoint?.status, "stale");
		assert.equal(log.tape().history().checkpoint?.text, "FOREIGN-SUMMARY", "a stale summary is still carried");
	});

	it("treats a compaction with a malformed cut marker as foreign", () => {
		const log = sessionLog();
		const first = log.turn("0");
		log.turn("1");
		const compaction = log.foreign(first.user, "looks like ours", { [CUT_DETAILS_KEY]: { version: 2 } });
		const tape = log.tape();
		assert.equal(tape.history().checkpoint?.id, compaction);
		assert.equal(tape.history().checkpoint?.owner, "foreign");
		assert.equal(tape.state.cuts, 0);
	});

	it("reads only the current branch after a branch jump", () => {
		const log = sessionLog();
		const first = log.turn("0");
		const abandoned = log.turn("1");
		log.replace(first.result, "edited on the abandoned branch");
		log.manager.branch(first.answer);
		const other = log.turn("2");
		const tape = log.tape();
		assert.deepEqual(ids(tape.archive().entries), [
			first.user,
			first.call,
			first.result,
			first.answer,
			other.user,
			other.call,
			other.result,
			other.answer,
		]);
		assert.ok(!ids(tape.history().entries).includes(abandoned.user));
		assert.match(textIn(tape.modelView().entries, first.result) ?? "", /FACT 0 holds/, "edits stay on their branch");
		assert.equal(statusOf(tape.archive(), first.result), "visible");
	});

	it("reads a resumed session file as the session that wrote it", () => {
		const dir = mkdtempSync(join(tmpdir(), "context-tape-"));
		const log = sessionLog(piSdk.SessionManager.create(dir, join(dir, "sessions")));
		const turns = ["0", "1", "2", "3"].map((label) => log.turn(label));
		const [t0, t1, , t3] = turns;
		assert.ok(t0 && t1 && t3);
		log.replace(t0.result, "replaced before the cut");
		log.foreign(t1.user, "FOREIGN-SUMMARY");
		log.turn("4");
		log.ownCut(t3.user);
		log.turn("5");
		const file = log.manager.getSessionFile();
		assert.ok(file);
		const written = log.tape();
		const resumed = SessionTape.read(piSdk.SessionManager.open(file).getBranch(), piSdk.buildSessionProjection, DEFAULT_CONFIG);
		assert.deepEqual(resumed.modelView(), written.modelView());
		assert.deepEqual(resumed.history(), written.history());
		assert.deepEqual(resumed.archive().items, written.archive().items);
		assert.deepEqual(resumed.state, written.state);
	});
});

describe("the session tape on pi " + VERSION + ": summaries", () => {
	it("distrusts a summary without source digests once any edit touches what it covers", () => {
		const log = sessionLog();
		log.turn("0");
		const second = log.turn("1");
		log.summary(second.answer, "build the parser");
		assert.equal(log.tape().history().summary?.coveredThroughId, second.answer);
		assert.equal(log.tape().history().summaryEligibility?.eligible, true);

		const later = log.turn("2");
		log.replace(later.result, "edited, but not covered");
		assert.equal(log.tape().history().summary?.coveredThroughId, second.answer);

		log.replace(second.result, "edited after, and covered");
		const history = log.tape().history();
		assert.equal(history.summary, undefined, "a summary that may hold edited-away text is not used");
		assert.deepEqual(history.summaryEligibility, {
			eligible: false,
			state: { version: 1, coveredThroughId: second.answer, sections: { ...emptySections(), goal: ["build the parser"] } },
			reason: "source-edited",
		});
	});

	it("distrusts a summary without source digests when the edit came before it", () => {
		const log = sessionLog();
		const first = log.turn("0");
		const second = log.turn("1");
		log.replace(first.result, "edited before the summary");
		log.summary(second.answer, "build the parser");
		const history = log.tape().history();
		assert.equal(history.summary, undefined, "an older summary may have been written from the original");
		assert.equal(history.summaryEligibility?.eligible, false);
	});

	it("trusts a summary made from the edited projection until a later edit touches what it covers", () => {
		const log = sessionLog();
		const first = log.turn("0");
		const second = log.turn("1");
		const edit = log.replace(first.result, "edited before the summary was read");
		log.summary(second.answer, "build the parser", edit);
		assert.equal(log.tape().history().summary?.coveredThroughId, second.answer, "the edit is in its sources");

		const later = log.turn("2");
		log.replace(later.result, "edited, but not covered");
		assert.equal(log.tape().history().summaryEligibility?.eligible, true);

		log.replace(second.result, "edited after, and covered");
		assert.equal(log.tape().history().summary, undefined);
		assert.equal(log.tape().history().summaryEligibility?.eligible, false);
	});

	it("distrusts a marked summary when an edit came between the read and the write", () => {
		const log = sessionLog();
		const first = log.turn("0");
		const second = log.turn("1");
		const readAt = second.answer;
		log.replace(first.result, "edited while the historian was out");
		log.summary(second.answer, "build the parser", readAt);
		assert.equal(log.tape().history().summaryEligibility?.eligible, false);
	});

	it("skips a summary whose marker names no entry of the branch, keeping the earlier one", () => {
		const log = sessionLog();
		const first = log.turn("0");
		const second = log.turn("1");
		log.summary(first.answer, "read the spec");
		log.summary(second.answer, "build the parser", "not-on-this-branch");
		assert.deepEqual(log.tape().history().summary?.sections.goal, ["read the spec"]);
	});

	it("names the branch's last entry, for the historian to mark what it read", () => {
		const log = sessionLog();
		const turn = log.turn("0");
		assert.equal(log.tape().state.leafId, turn.answer);
	});
});

describe("the session tape on pi " + VERSION + ": the model view is the request", () => {
	it("equals the messages pi sends to the provider, edits and compaction included", async () => {
		const registration = piAi.registerFauxProvider({
			models: [{ id: "faux-tape", reasoning: false, contextWindow: 200_000, maxTokens: 4_096 }],
		});
		const model = registration.getModel();
		const captured: FauxContext[] = [];
		const views: ModelView[] = [];
		let session: Awaited<ReturnType<typeof piSdk.createAgentSession>>["session"] | undefined;
		registration.setResponses(
			Array.from({ length: 8 }, () => (context: FauxContext) => {
				captured.push(context);
				if (session) {
					views.push(SessionTape.read(session.sessionManager.getBranch(), piSdk.buildSessionProjection, DEFAULT_CONFIG).modelView());
				}
				return piAi.fauxAssistantMessage(piAi.fauxText("ok"));
			}),
		);
		const dir = mkdtempSync(join(tmpdir(), "context-tape-request-"));
		try {
			const provider = (pi: ExtensionAPI) =>
				pi.registerProvider(model.provider, {
					baseUrl: model.baseUrl,
					apiKey: "faux-key",
					api: registration.api,
					models: registration.models.map((registered) => ({
						id: registered.id,
						name: registered.name,
						api: registered.api,
						reasoning: registered.reasoning,
						input: registered.input,
						cost: registered.cost,
						contextWindow: registered.contextWindow,
						maxTokens: registered.maxTokens,
					})),
				} as never);
			const loader = new piSdk.DefaultResourceLoader({
				cwd: dir,
				agentDir: dir,
				extensionFactories: [provider],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await loader.reload();
			const modelRuntime = await piSdk.ModelRuntime.create({
				authPath: join(dir, "auth.json"),
				modelsPath: join(dir, "models.json"),
			});
			const created = await piSdk.createAgentSession({
				cwd: dir,
				agentDir: dir,
				modelRuntime,
				resourceLoader: loader,
				sessionManager: piSdk.SessionManager.inMemory(dir),
				model: model as never,
			});
			session = created.session;
			await session.bindExtensions({});
			await session.prompt(OBSOLETE);
			await session.prompt("second prompt");
			await session.prompt("third prompt");
			const manager = session.sessionManager;
			const users = manager
				.getBranch()
				.filter((entry: SessionEntry) => entry.type === "message" && entry.message.role === "user");
			const [obsolete, second] = users;
			assert.ok(obsolete && second);
			manager.appendContextEdit(obsolete.id, { content: [{ type: "text", text: "(withdrawn)" }] });
			manager.appendCompaction("FOREIGN-SUMMARY before the second prompt", second.id, 0, undefined, false);
			await session.prompt("fourth prompt");

			const request = captured.at(-1);
			const view = views.at(-1);
			assert.ok(request && view);
			assert.deepEqual(piSdk.convertToLlm(view.messages as never), request.messages);
			const sent = JSON.stringify(request.messages);
			assert.ok(!sent.includes("OBSOLETE"), "pi sends the edited message");
			assert.match(sent, /FOREIGN-SUMMARY before the second prompt/);
			assert.equal(view.checkpoint?.owner, "foreign");
		} finally {
			session?.dispose();
			registration.unregister();
		}
	});

	it("equals the request with the context extension loaded, its answered keep-warm ping removed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-tape-ping-"));
		const { runtime, faux } = await openRuntime({
			dir,
			manager: piSdk.SessionManager.inMemory(dir) as never,
			trace: [],
			options: { configFile: false, ledgerFile: false, keepWarm: false },
		});
		const captured: FauxContext[] = [];
		const tapes: SessionTape[] = [];
		faux.setResponses(
			Array.from({ length: 4 }, () => (context: FauxContext) => {
				captured.push(context);
				tapes.push(SessionTape.read(runtime.session.sessionManager.getBranch(), piSdk.buildSessionProjection, DEFAULT_CONFIG));
				return piAi.fauxAssistantMessage(piAi.fauxText("ok"));
			}),
		);
		try {
			await runtime.session.bindExtensions({});
			await runtime.session.prompt("first prompt");
			const manager = runtime.session.sessionManager;
			const ping = manager.appendCustomMessageEntry(KEEP_WARM_KIND, "KEEP-WARM-PROBE", false);
			const answer = manager.appendMessage(piAi.fauxAssistantMessage(piAi.fauxText("pong")) as never);
			await runtime.session.prompt("second prompt");

			const request = captured.at(-1);
			const tape = tapes.at(-1);
			assert.ok(request && tape);
			const sent = JSON.stringify(request.messages);
			assert.ok(!sent.includes("KEEP-WARM-PROBE"), "the extension removes the answered ping");
			assert.deepEqual(piSdk.convertToLlm(tape.modelView().messages as never), request.messages);
			assert.ok(!ids(tape.modelView().entries).includes(ping));
			assert.ok(!ids(tape.modelView().entries).includes(answer));
			const statuses = new Map(tape.archive().entries.map((entry) => [entry.id, entry.status]));
			assert.equal(statuses.get(ping), "omitted");
			assert.equal(statuses.get(answer), "omitted");
		} finally {
			await runtime.dispose();
			faux.unregister();
		}
	});
});

describe("the session tape on pi " + VERSION + ": state outside the views", () => {
	it("counts the assistant's thinking, which the model sees again", () => {
		const log = sessionLog();
		const answer = log.answer("ok", "x".repeat(4_000));
		const [entry] = log.tape().modelView().entries;
		assert.equal(entry?.id, answer);
		assert.ok(entry && entry.tokens >= 1_000, "thinking not counted: " + entry?.tokens);
		assert.equal(entry?.text, "ok", "thinking stays out of the searchable text");
	});

	it("counts as visible only what the prompt holds: the latest cut's text and the entries it kept", () => {
		const log = sessionLog();
		log.user("a".repeat(4_000));
		const kept = log.user("b".repeat(400));
		log.ownCut(kept, "c".repeat(800));
		log.answer("d".repeat(40));
		assert.equal(log.tape().modelView().tokens, 100 + 200 + 10);
		const uncut = sessionLog();
		uncut.user("a".repeat(4_000));
		uncut.user("b".repeat(400));
		uncut.answer("d".repeat(40));
		assert.equal(uncut.tape().modelView().tokens, 1_000 + 100 + 10);
	});

	it("keeps a finished task's cut chance until the next prompt or a cut", () => {
		const log = sessionLog();
		const work = log.user("work");
		log.manager.appendCustomEntry(TASK_DONE_KIND, { closed: ["IDEA-1"] });
		assert.equal(log.tape().state.taskCutPending, true);
		log.ownCut(work);
		assert.equal(log.tape().state.taskCutPending, false);
		log.manager.appendCustomEntry(TASK_DONE_KIND, { closed: ["IDEA-2"] });
		assert.equal(log.tape().state.taskCutPending, true);
		log.user("next");
		assert.equal(log.tape().state.taskCutPending, false);
	});

	it("reads the notebook from its entry or from an old tool result, the latest write winning", () => {
		const log = sessionLog();
		log.result("call", "notebook", "Notebook saved.", { text: "old plan" });
		assert.equal(log.tape().state.notebook, "old plan");
		log.manager.appendCustomEntry(NOTEBOOK_KIND, { text: "new plan" });
		assert.equal(log.tape().state.notebook, "new plan");
		assert.equal(log.tape().history().notebook, "new plan");
		log.result("call-2", "notebook", "Notebook saved.", { text: "newer plan" });
		assert.equal(log.tape().state.notebook, "newer plan");
		log.manager.appendCustomEntry(NOTEBOOK_KIND, {});
		assert.equal(log.tape().state.notebook, "newer plan", "an entry without text is skipped");
		log.manager.appendCustomEntry(NOTEBOOK_KIND, { text: "" });
		assert.equal(log.tape().state.notebook, "");
	});

	it("marks the notebook stale after a compaction until it is written again", () => {
		const log = sessionLog();
		const first = log.user("work");
		log.manager.appendCustomEntry(NOTEBOOK_KIND, { text: "plan" });
		assert.equal(log.tape().state.notebookCurrent, true);
		log.foreign(first, "pi");
		assert.equal(log.tape().state.notebook, "plan");
		assert.equal(log.tape().state.notebookCurrent, false);
		log.manager.appendCustomEntry(NOTEBOOK_KIND, { text: "plan 2" });
		assert.equal(log.tape().state.notebookCurrent, true);
	});
});

/** Type-level fixtures: \`npm run typecheck\` fails as soon as one of these assignments compiles. */
export function captureBoundaries(tape: SessionTape): void {
	const archive = tape.archive();
	const history = tape.history();
	const view = tape.modelView();
	// @ts-expect-error archive evidence is not the model view
	const archiveAsView: ModelView = archive;
	// @ts-expect-error archive evidence is not the history
	const archiveAsHistory: EffectiveHistory = archive;
	// @ts-expect-error raw entries do not make a history without the session reader
	const entriesAsHistory: EffectiveHistory = {
		entries: archive.entries,
		checkpoint: undefined,
		minKeptIndex: 0,
		visibleFromIndex: 0,
		summary: undefined,
		summaryEligibility: undefined,
		notebook: undefined,
	};
	// @ts-expect-error raw entries do not make a model view without the session reader
	const entriesAsView: ModelView = { messages: [], checkpoint: undefined, entries: archive.entries, tokens: 0 };
	// @ts-expect-error a history is not the model view
	const historyAsView: ModelView = history;
	// @ts-expect-error the model view is not the history
	const viewAsHistory: EffectiveHistory = view;
	void [archiveAsView, archiveAsHistory, entriesAsHistory, entriesAsView, historyAsView, viewAsHistory];
}

describe("the historian and the session tape on pi " + VERSION + ": summaries of edited history", () => {
	it("keeps the old wording of an edited constraint out of the summary, the cut and the condenser's input", async () => {
		const log = sessionLog();
		const rule = log.user("RULE: never touch the billing module");
		log.answer("Understood.");
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		const run = harness(log, config);
		await run.run();
		const before = log.tape().history().summary;
		assert.ok(JSON.stringify(before).includes("never touch the billing module"), "the summary holds the constraint");

		log.replace(rule, "RULE: the billing module may be touched after all");
		const history = log.tape().history();
		assert.ok(history.summary, "the unedited rest of the summary stays");
		assert.ok(!JSON.stringify(history.summary).includes("never touch"), "the summary");
		await harness(log, config).run();
		const again = JSON.stringify(log.tape().history().summary);
		assert.match(again, /the billing module may be touched after all/, "the edited stretch is summarized again as it reads now");
		assert.match(again, /FACT a holds\./, "with what the edit did not touch");
		assert.ok(!again.includes("never touch"));
		assert.ok(!(planFrom(history)?.text ?? "").includes("never touch"), "the cut");
		const selection = condenseSelection(history.summary as NonNullable<typeof history.summary>, 1);
		assert.ok(!(selection ? condensePrompt(selection) : "").includes("never touch"), "the condenser");
		assert.ok(storedSummaries(log).length > 0);
	});

	it("carries a stale foreign checkpoint with a warning, then replaces it with a summary of the edited sources", async () => {
		const log = sessionLog();
		const [t0, t1] = ["0", "1"].map((label) => log.turn(label, 2_000));
		assert.ok(t0 && t1);
		log.foreign(t1.user, "FOREIGN-SUMMARY: OLDFACT the release code is old-code-77");
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		log.replace(t0.result, "FACT the release code is new-code-88");

		const stale = log.tape().history();
		assert.equal(stale.checkpoint?.status, "stale");
		const carried = planFrom(stale)?.text ?? "";
		assert.match(carried, /OLDFACT the release code is old-code-77/);
		assert.match(carried, /Stale/, "the cut says the checkpoint is stale");

		// Another extension compacts too: the checkpoint stays, whatever our summary holds.
		const competing = harness(log, config, { competing: true });
		await competing.run();
		assert.ok(!storedSummaries(log).some((summary) => summary.supersedes !== undefined), "no summary stands in for it");
		assert.match(planFrom(log.tape().history(), true)?.text ?? "", /OLDFACT/);
	});

	it("replaces a stale foreign checkpoint at the next cut when nobody else compacts", async () => {
		const log = sessionLog();
		const [t0, t1] = ["0", "1"].map((label) => log.turn(label, 2_000));
		assert.ok(t0 && t1);
		const foreign = log.foreign(t1.user, "FOREIGN-SUMMARY: OLDFACT the release code is old-code-77");
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		log.replace(t0.result, "FACT the release code is new-code-88");

		const run = harness(log, config);
		await run.run();
		assert.deepEqual(run.failures, []);
		const summary = storedSummaries(log).at(-1);
		assert.equal(summary?.supersedes, foreign);
		const history = log.tape().history();
		assert.equal(history.checkpointSuperseded, true);
		const text = planFrom(history)?.text ?? "";
		assert.ok(!text.includes("OLDFACT") && !text.includes("old-code-77"), "the edited-away fact is not in the cut");
		assert.ok(!JSON.stringify(history.summary).includes("old-code-77"), "nor in the summary");
		assert.match(text, /new-code-88/, "the edited text is");
		// A competing owner appearing later keeps the checkpoint after all.
		assert.match(planFrom(history, true)?.text ?? "", /OLDFACT/);
	});
});

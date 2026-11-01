import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll as after, beforeAll as before, describe, it } from "vitest";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../src/core/config.ts";
import { CUT_REQUEST_CHANNEL } from "../src/core/kinds.ts";
import { cacheTtlMs } from "../src/core/policy.ts";
import type { ContextExtensionOptions } from "../src/pi/extension.ts";
import { KEEP_WARM_PING } from "../src/pi/keep-warm.ts";
import { capturedTools } from "./support/captured.ts";
import { type FauxContext, type FauxRegistration, piAi, piSdk, typebox } from "./support/pi.ts";
import { condenserAnswer, historianAnswer, probeText, textOf } from "./support/pi-scenario.ts";

/*
 * End to end in the real pi runtime: pi's extension loader, agent loop, session file and
 * compaction pipeline, with pi's faux provider standing in for the model. The faux provider
 * receives exactly the context pi would send, so cache continuity is checked on real requests.
 */

const here = dirname(fileURLToPath(import.meta.url));
const NOTE = "Remember: the user wants tabs, not spaces.";
const WATERMARK = 24_000;

type Task =
	| { readonly kind: "work"; readonly label: string; readonly probes: number }
	| { readonly kind: "tool"; readonly name: string; readonly args: Record<string, unknown> };

interface AgentRequest {
	readonly items: readonly string[];
	readonly compactions: number;
	readonly tokens: number;
}

type Session = Awaited<ReturnType<typeof piSdk.createAgentSession>>["session"];
type Entry = ReturnType<Session["sessionManager"]["getEntries"]>[number];

function sandyCompactions(entries: readonly Entry[]) {
	return entries.flatMap((entry) =>
		entry.type === "compaction" && (entry.details as { sandyContext?: unknown } | undefined)?.sandyContext !== undefined
			? [entry as Entry & { type: "compaction"; summary: string; details: { sandyContext: { reason: string } } }]
			: [],
	);
}

describe("sandy-context in the pi runtime", () => {
	let tempDir = "";
	let faux: FauxRegistration | undefined;
	let session: Session | undefined;
	let offset = 0;
	const retention = () => (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");
	let task: Task = { kind: "work", label: "none", probes: 0 };
	let step = 0;
	let historianCalls = 0;
	let condenserCalls = 0;
	let remindersAnswered = 0;
	let coldPromptTokens: number | undefined;
	let switchPromptTokens: number | undefined;
	let pings = 0;
	let pingRequest = -1;
	let resumed = -1;
	let signalFile = "";
	let bus: ExtensionAPI["events"] | undefined;
	let idleTaskTokens: number | undefined;
	let runTaskTokens: number | undefined;
	const requests: AgentRequest[] = [];
	const snapshots: string[] = [];
	let ledgerFile = "";

	const entries = (): Entry[] => session?.sessionManager.getEntries() ?? [];

	function respond(context: FauxContext): unknown {
		// Pi passes the prompt and tool declarations as system messages inside the transcript.
		const serialized = JSON.stringify(context.messages);
		if (serialized.includes("historian of a long-running")) {
			historianCalls++;
			return piAi.fauxAssistantMessage(historianAnswer(textOf(context.messages.at(-1)?.content)));
		}
		if (serialized.includes("You condense the oldest records")) {
			condenserCalls++;
			return piAi.fauxAssistantMessage(condenserAnswer(textOf(context.messages.at(-1)?.content)));
		}
		requests.push({
			items: context.messages.map((message) => JSON.stringify(message)),
			compactions: sandyCompactions(entries()).length,
			tokens: Math.ceil(serialized.length / 4),
		});
		// The keep-warm ping: answer it, and end the wait the signal announced, as a continuing workflow would.
		if (textOf(context.messages.at(-1)?.content).includes(KEEP_WARM_PING)) {
			pings++;
			pingRequest = requests.length - 1;
			rmSync(signalFile, { force: true });
			return piAi.fauxAssistantMessage("ok");
		}
		// A diligent agent: answer the notebook reminder by writing the notebook, then carry on.
		// It writes from inside a program, the way an agent calls tools.notebook from a codemode script.
		if (textOf(context.messages.at(-1)?.content).includes("A context cut is coming")) {
			remindersAnswered++;
			const text = `${NOTE}\nReminders answered: ${remindersAnswered}`;
			return piAi.fauxAssistantMessage([piAi.fauxToolCall("program", { tool: "notebook", args: { text } })], {
				stopReason: "toolUse",
			});
		}
		step++;
		if (task.kind === "work") {
			if (step <= task.probes) {
				return piAi.fauxAssistantMessage([piAi.fauxToolCall("probe", { label: `${task.label}-${step}` })], {
					stopReason: "toolUse",
				});
			}
			return piAi.fauxAssistantMessage(`Finished ${task.label}.`);
		}
		if (step === 1)
			return piAi.fauxAssistantMessage([piAi.fauxToolCall(task.name, task.args)], { stopReason: "toolUse" });
		return piAi.fauxAssistantMessage("Done.");
	}

	async function run(next: Task, text: string): Promise<void> {
		assert.ok(session);
		task = next;
		step = 0;
		await session.prompt(text);
		// Let the background historian finish before the next prompt.
		await new Promise((resolve) => setTimeout(resolve, 30));
		const file = session.sessionManager.getSessionFile();
		if (file && existsSync(file)) snapshots.push(readFileSync(file, "utf8"));
	}

	const work = (label: string, probes = 3) => run({ kind: "work", label, probes }, `TASK work ${label}`);
	const tool = (name: string, args: Record<string, unknown>) => run({ kind: "tool", name, args }, `TASK ${name}`);

	before(async () => {
		tempDir = mkdtempSync(join(tmpdir(), "sandy-context-"));
		ledgerFile = join(tempDir, "ledger.jsonl");
		signalFile = join(tempDir, "keep-warm", "thread.json");
		const registration = piAi.registerFauxProvider({
			models: [
				{ id: "faux-ctx", reasoning: false, contextWindow: 200_000, maxTokens: 4_096 },
				{ id: "faux-ctx-2", reasoning: false, contextWindow: 200_000, maxTokens: 4_096 },
			],
		});
		faux = registration;
		registration.setResponses(Array.from({ length: 4_000 }, () => respond));
		const model = registration.getModel();

		const options: ContextExtensionOptions = {
			configFile: false,
			ledgerFile,
			now: () => Date.now() + offset,
			keepWarm: { file: signalFile, intervalMs: 20 },
			config: {
				watermarkTokens: WATERMARK,
				keepRecentTokens: 5_000,
				maskedTokens: 2_000,
				pinnedUserTokens: 1_000,
				// Small enough that the summary has to be condensed during the run.
				summaryTokens: 600,
				coldCutMinTokens: 9_000,
				taskCutMinTokens: 9_000,
				historian: { chunkMinTokens: 3_000, chunkMaxTokens: 8_000, maxOutputTokens: 1_000 },
			},
		};
		(globalThis as { __sandyContextTest?: ContextExtensionOptions }).__sandyContextTest = options;

		const probes = (pi: ExtensionAPI) => {
			bus = pi.events;
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
			});
			// Stands in for codemode: runs a captured extension tool from inside its own call,
			// so the session file only shows this tool's call and result.
			pi.registerTool({
				name: "program",
				label: "Program",
				description: "Run another extension tool from code.",
				parameters: typebox.Type.Object({
					tool: typebox.Type.String(),
					args: typebox.Type.Record(typebox.Type.String(), typebox.Type.Unknown()),
				}),
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					const definition = capturedTools().get(params.tool);
					if (!definition) throw new Error(`no captured tool ${params.tool}`);
					const result = await definition.execute(`${toolCallId}-nested`, params.args as never, signal, onUpdate, ctx);
					return {
						content: [{ type: "text", text: `ran ${params.tool}: ${textOf(result.content)}` }],
						details: undefined,
					};
				},
			});
			pi.registerTool({
				name: "probe",
				label: "Probe",
				description: "Return a fact about a module, with filler output.",
				parameters: typebox.Type.Object({ label: typebox.Type.String() }),
				async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
					// A task finished during a run, as the ideas advisor reports it: cut before the next request.
					if (params.label === "handover-1") {
						runTaskTokens = ctx.getContextUsage()?.tokens ?? undefined;
						bus?.emit(CUT_REQUEST_CHANNEL, { reason: "task done" });
					}
					return { content: [{ type: "text", text: probeText(params.label) }], details: undefined };
				},
			});
		};

		const modelRuntime = await piSdk.ModelRuntime.create({
			authPath: join(tempDir, "auth.json"),
			modelsPath: join(tempDir, "models.json"),
		});
		const loader = new piSdk.DefaultResourceLoader({
			cwd: tempDir,
			agentDir: tempDir,
			additionalExtensionPaths: [join(here, "fixtures", "extension-under-test.ts")],
			extensionFactories: [probes],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const created = await piSdk.createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: piSdk.SessionManager.create(tempDir, join(tempDir, "sessions")),
			// Pi's manual compaction refuses to run unless history older than its own keepRecentTokens
			// exists (default 20k). Production cold cuts start at 60k, so only this small test lowers it.
			settingsManager: piSdk.SettingsManager.inMemory({ compaction: { keepRecentTokens: 2_000 } }),
			model: model as never,
		});
		session = created.session;
		await session.bindExtensions({});

		await work("p0");
		await work("p1");
		await tool("notebook", { text: NOTE });
		for (let prompt = 2; prompt < 14; prompt++) await work(`p${prompt}`);
		coldPromptTokens = session.getContextUsage()?.tokens ?? undefined;
		// Past the cache lifetime of the tier the environment picks, so PI_CACHE_RETENTION=long cannot keep it warm.
		offset += cacheTtlMs(resolveConfig(options.config), session.model, retention()) + 60_000;
		await work("cold", 1);
		await tool("history_search", { query: "fact-p0-1" });
		const probeEntry = entries().find(
			(entry) =>
				entry.type === "message" &&
				textOf((entry.message as { content?: unknown }).content).includes("FACT fact-p0-1 ="),
		);
		assert.ok(probeEntry, "probe result for fact-p0-1 is in the session");
		await tool("history_read", { id: probeEntry.id });
		for (let prompt = 14; prompt < 20; prompt++) await work(`p${prompt}`);
		switchPromptTokens = session.getContextUsage()?.tokens ?? undefined;
		const other = registration.models.find((registered) => registered.id === "faux-ctx-2");
		assert.ok(other, "second faux model");
		await session.setModel(other as never);
		await work("switched", 1);

		// A workflow parks the session and announces its next prompt half a cache lifetime after the cache expires.
		assert.equal(pings, 0, "no ping without a signal");
		const ttl = cacheTtlMs(resolveConfig(options.config), session.model, retention());
		// The faux answers carry the real time, so the clock now runs to 30 seconds before the cache expires.
		offset = ttl - 30_000;
		mkdirSync(dirname(signalFile), { recursive: true });
		writeFileSync(signalFile, JSON.stringify({ until: Date.now() + offset + 0.5 * ttl }));
		for (let waited = 0; pings === 0 && waited < 3_000; waited += 20)
			await new Promise((resolve) => setTimeout(resolve, 20));
		await new Promise((resolve) => setTimeout(resolve, 200));
		resumed = requests.length;
		await work("resumed", 1);

		// A task finished between two prompts, then one finished during a run; each request is used once.
		const grow = async (label: string) => {
			for (let prompt = 0; prompt < 12 && (session?.getContextUsage()?.tokens ?? 0) < 12_000; prompt++)
				await work(`${label}${prompt}`);
		};
		await grow("before-idle-task-");
		idleTaskTokens = session.getContextUsage()?.tokens ?? undefined;
		bus?.emit(CUT_REQUEST_CHANNEL, { reason: "task done" });
		await work("next-task", 1);
		await grow("before-run-task-");
		await work("handover", 3);
		await work("after-handover", 1);
	});

	after(() => {
		session?.dispose();
		faux?.unregister();
		delete (globalThis as { __sandyContextTest?: unknown }).__sandyContextTest;
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
	});

	it("cuts at the watermark and keeps every request below it plus one turn", () => {
		const reasons = sandyCompactions(entries()).map((entry) => entry.details.sandyContext.reason);
		assert.ok(reasons.filter((reason) => reason === "watermark").length >= 2, `watermark cuts: ${reasons.join(", ")}`);
		const largest = Math.max(...requests.map((request) => request.tokens));
		// An interactive cut waits for the next prompt. A run crosses the watermark by up to one request (~1.2k) and may
		// then make three more requests of ~1.2k each; where it crosses depends on what the previous cut kept.
		assert.ok(largest <= WATERMARK + 5_000, `largest request ${largest} tokens`);
	});

	it("breaks the prompt cache only where a cut happened", () => {
		let breaks = 0;
		const unplanned: number[] = [];
		const missed: number[] = [];
		for (let index = 1; index < requests.length; index++) {
			// After a ping, the cache holds the prompt the ping read; the ping itself leaves the context.
			const previous = requests[index - 1 === pingRequest ? index - 2 : index - 1];
			const current = requests[index];
			if (!previous || !current) continue;
			const continued = previous.items.every((item, position) => current.items[position] === item);
			const cut = current.compactions > previous.compactions;
			if (!continued) breaks++;
			if (!continued && !cut) unplanned.push(index);
			if (continued && cut) missed.push(index);
		}
		assert.deepEqual(unplanned, [], "requests that broke the cache without a cut");
		assert.deepEqual(missed, [], "cuts that did not reach the model");
		assert.equal(breaks, sandyCompactions(entries()).length);
		assert.ok(requests.length > 50, `${requests.length} agent requests`);
	});

	it("uses an expired cache for a cut before the next prompt", () => {
		assert.ok((coldPromptTokens ?? 0) >= 9_000, `prompt before the idle gap: ${coldPromptTokens} tokens`);
		const reasons = sandyCompactions(entries()).map((entry) => entry.details.sandyContext.reason);
		assert.ok(reasons.includes("cold"), `cut reasons: ${reasons.join(", ")}`);
	});

	it("uses a model switch for a cut before the next prompt", () => {
		assert.ok((switchPromptTokens ?? 0) >= 9_000, `prompt before the switch: ${switchPromptTokens} tokens`);
		const reasons = sandyCompactions(entries()).map((entry) => entry.details.sandyContext.reason);
		assert.ok(reasons.includes("model"), `cut reasons: ${reasons.join(", ")}`);
	});

	it("cuts after a finished task, before the next prompt or the next request of a run, once per request", () => {
		assert.ok((idleTaskTokens ?? 0) >= 9_000, `prompt before the idle task cut: ${idleTaskTokens} tokens`);
		assert.ok((runTaskTokens ?? 0) >= 9_000, `prompt before the run task cut: ${runTaskTokens} tokens`);
		const all = entries();
		const tasks = sandyCompactions(all).filter((entry) => entry.details.sandyContext.reason === "task");
		assert.equal(tasks.length, 2, "one cut per request");
		const position = (text: string) =>
			all.findLastIndex(
				(entry) => entry.type === "message" && textOf((entry.message as { content?: unknown }).content).includes(text),
			);
		const [idle, run] = tasks.map((cut) => all.indexOf(cut));
		assert.ok(idle !== undefined && idle < position("TASK work next-task"), "idle cut precedes the next prompt");
		assert.ok(idle > position("TASK work before-idle-task-"), "idle cut follows the finished task");
		assert.ok(run !== undefined && run > position("FACT fact-handover-1 ="), "run cut follows the turn that finished it");
		assert.ok(run < position("Finished handover."), "run cut lands inside the run");
	});

	it("pings a waiting session once, on its cache, when that is cheaper than going cold", () => {
		assert.equal(pings, 1, "pings");
		const ping = requests[pingRequest];
		const previous = requests[pingRequest - 1];
		assert.ok(ping && previous);
		assert.ok(
			previous.items.every((item, position) => ping.items[position] === item),
			"the ping continues the cached prompt",
		);
		const next = requests[resumed]?.items ?? [];
		assert.ok(
			previous.items.every((item, position) => next[position] === item) &&
				!next.some((i) => i.includes(KEEP_WARM_PING)),
			"the next prompt continues the prompt the ping read, without the ping",
		);
		const records = readFileSync(ledgerFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { class: string });
		assert.equal(records.filter((record) => record.class === "keep-warm").length, 1);
	});

	it("summarizes in the background and carries summary, notebook and pins into the cut", () => {
		assert.ok(historianCalls > 0);

		const summaries = entries().filter(
			(entry) => entry.type === "custom" && entry.customType === "sandy-context.summary",
		);
		assert.ok(summaries.length > 0);
		const last = sandyCompactions(entries()).at(-1);
		assert.ok(last);
		assert.match(last.summary, /## Summary of older work \(through #\w+\)/);
		assert.match(last.summary, /fact-p\d+-\d is value-p\d+-\d \(#\w+\)/);
		assert.ok(last.summary.includes(NOTE), "notebook carried verbatim");
		assert.match(last.summary, /## Earlier user messages, verbatim\n[\s\S]*TASK work p/);
		assert.ok("systemMessage" in last, "pi stored a system checkpoint with the cut");
		// Older chapters may be condensed ahead of it in a long session.
		assert.match(last.summary, /### Chapters\n(?:- .*\n)*- Untitled stretch \(#\w+ … #\w+\)/);
	});

	it("condenses the oldest records instead of dropping them when the summary outgrows its budget", () => {
		assert.ok(condenserCalls > 0);
		const stored = entries().flatMap((entry) =>
			entry.type === "custom" && entry.customType === "sandy-context.summary"
				? [entry.data as { sections: Record<string, string[]>; condenseUsage?: unknown }]
				: [],
		);
		assert.ok(stored.some((summary) => summary.condenseUsage !== undefined));
		const facts = stored.at(-1)?.sections.facts ?? [];
		assert.match(facts[0] ?? "", /^\d+ records \(#\w+ … #\w+\)$/);
	});

	it("finds archived history and reads it in full", () => {
		const results = entries().flatMap((entry) => {
			if (entry.type !== "message") return [];
			const message = entry.message as { role?: string; toolName?: string; content?: unknown };
			return message.role === "toolResult" ? [{ tool: message.toolName, text: textOf(message.content) }] : [];
		});
		const search = results.find((result) => result.tool === "history_search");
		assert.ok(search);
		assert.match(search.text, /matches in archived history for "fact-p0-1"/);
		assert.match(search.text, /#\w+ · tool probe · .*\n.*FACT fact-p0-1 = value-p0-1/);
		const read = results.find((result) => result.tool === "history_read");
		assert.ok(read);
		assert.match(read.text, /FACT fact-p0-1 = value-p0-1\nline 0 of probe output/);
	});

	it("puts the context guidance into the system prompt", () => {
		const first = requests[0];
		assert.ok(first);
		const system = first.items.filter((item) => item.includes("This session can run indefinitely"));
		assert.equal(system.length, 1, "guidance appears once in the request");
		assert.match(system[0] ?? "", /sandy-context/);
		assert.ok(
			requests.every((request) => request.items.some((item) => item.includes("This session can run indefinitely"))),
		);
	});

	it("reminds about the notebook at most once per cut, and the written notebook reaches the next cut", () => {
		let reminders = 0;
		let perCut = 0;
		for (const entry of entries()) {
			if (entry.type === "compaction") perCut = 0;
			if (entry.type === "custom_message" && entry.customType === "sandy-context.notebook-reminder") {
				reminders++;
				perCut++;
				assert.ok(perCut <= 1, "two reminders between cuts");
			}
		}
		assert.ok(reminders >= 1, "no reminder before a cut with a stale notebook");
		assert.equal(remindersAnswered, reminders, "every reminder reached the model");
		// Every cut carries the latest notebook, also when it was written from inside a program.
		let written = 0;
		let checked = 0;
		for (const entry of entries()) {
			const message =
				entry.type === "message"
					? (entry.message as { role?: string; toolName?: string; isError?: boolean })
					: undefined;
			if (message?.role === "toolResult" && message.toolName === "program" && message.isError !== true) written++;
			const cut = sandyCompactions([entry])[0];
			if (cut && written > 0) {
				assert.ok(
					cut.summary.includes(`Reminders answered: ${written}`),
					`cut after ${written} nested writes carries an older notebook`,
				);
				checked++;
			}
		}
		assert.ok(checked >= 1, "no cut after a nested notebook write");
	});

	it("only ever appends to the session file", () => {
		assert.ok(snapshots.length > 10);
		for (let index = 1; index < snapshots.length; index++) {
			assert.ok(
				(snapshots[index] ?? "").startsWith(snapshots[index - 1] ?? ""),
				`snapshot ${index} rewrote earlier content`,
			);
		}
	});

	it("records request continuity in the ledger when the provider exposes payloads", async (t) => {
		if (!existsSync(ledgerFile)) {
			await t.annotate("the faux provider emits no before_provider_request; ledger not exercised here");
			return;
		}
		const records = readFileSync(ledgerFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { class: string });
		assert.deepEqual(
			records.filter((record) => record.class === "unplanned"),
			[],
		);
	});
});

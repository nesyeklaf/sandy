import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Advisor, type Entry } from "../core/runtime.ts";
import { loadConfig, type AdvisorConfig } from "../core/config.ts";
import { AgentAsker } from "./agentAsker.ts";
import { notesMessage, type WatchSnapshot } from "../core/watch.ts";
import { textOf, type CompleteFn, type Msg, type Reply } from "../core/types.ts";

const CONFIG_FILES = (cwd: string): string[] => [join(homedir(), ".pi", "agent", "advisor.json"), join(cwd, ".pi", "advisor.json")];
const pct = (x: number): string => `${Math.round(x * 100)}%`;
/**
 * pi/context listens here and cuts its context before the next prompt. Same string as CUT_REQUEST_CHANNEL in
 * pi/context; the packages share no code, so test/channel.test.ts holds the two together.
 */
export const CUT_REQUEST_CHANNEL = "context.cut-request";
const WATCH_ENTRY = "advisor-watch";

export default function advisorExtension(pi: ExtensionAPI): void {
	let advisor: Advisor | undefined;
	let config: AdvisorConfig | undefined;
	let configErrors: string[] = [];
	let enabled = true;
	let lastCtx: ExtensionContext | undefined;

	const completeFor = (ctx: ExtensionContext, cfg: AdvisorConfig): CompleteFn => async (context, opts) => {
		const model = ctx.modelRegistry.find(cfg.model.provider, cfg.model.id);
		if (!model) throw new Error(`advisor model ${cfg.model.provider}/${cfg.model.id} not found`);
		const reply = await ctx.modelRegistry.complete(model, context as never, opts as never);
		return reply as unknown as Reply;
	};

	const entries = (ctx: ExtensionContext, exceptText?: string): Entry[] => {
		const out: Entry[] = [];
		for (const e of ctx.sessionManager.getBranch()) {
			if (e.type === "message") out.push({ id: e.id, message: e.message as unknown as Msg });
		}
		// message_end may already see the answer in the branch; the gate checks it separately.
		const last = out.at(-1)?.message;
		if (exceptText !== undefined && last?.role === "assistant" && textOf(last) === exceptText) out.pop();
		return out;
	};

	let answerBeingChecked: string | undefined;
	let savedWatch = "";
	const checkState = (): void => {
		const a = advisor;
		if (!a || !enabled) return;
		void a
			.poll()
			.then((c) => {
				const snapshot = a.watchSnapshot();
				if (snapshot && JSON.stringify(snapshot) !== savedWatch) {
					savedWatch = JSON.stringify(snapshot);
					pi.appendEntry(WATCH_ENTRY, snapshot);
				}
				if (!c) return;
				if (c.closed.length > 0) pi.events.emit(CUT_REQUEST_CHANNEL, { closed: c.closed });
				if (c.notes.length > 0) pi.sendMessage({ customType: "advisor-owner-notes", content: notesMessage(c.notes), display: true }, { triggerTurn: false, deliverAs: "nextTurn" });
			})
			.catch(() => undefined);
	};
	const start = (ctx: ExtensionContext): void => {
		lastCtx = ctx;
		const loaded = loadConfig(CONFIG_FILES(ctx.cwd));
		config = loaded.config;
		configErrors = loaded.errors;
		const threadId = process.env.SANDY_THREAD_ID;
		if (!threadId) config = { ...config, proposals: { ...config.proposals, enabled: false } };
		enabled = config.enabled;
		advisor?.ctx.dispose?.();
		const model = ctx.modelRegistry.find(config.model.provider, config.model.id);
		const primary = (): readonly SessionEntry[] => (lastCtx ?? ctx).sessionManager.getBranch();
		advisor = new Advisor({
			config,
			...(config.agent.enabled && model && { asker: new AgentAsker({ config, cwd: ctx.cwd, model, primary }) }),
			complete: completeFor(ctx, config),
			exec: async (cmd, args) => {
				const r = await pi.exec(cmd, args, { timeout: 15_000 });
				return { code: r.code, stdout: r.stdout, stderr: r.stderr };
			},
			sandy: process.env.SANDY_CLI ?? "sandy",
			sessionId: ctx.sessionManager.getSessionId(),
			...(threadId && { threadId }),
			entries: () => entries(lastCtx ?? ctx, answerBeingChecked),
		});
		if (enabled) void advisor.ctx.warm?.();
		// A reload or restart starts a fresh pi process: the open tasks seen last come from the session log, so a task closed meanwhile still counts.
		const last = ctx.sessionManager
			.getBranch()
			.filter((e) => e.type === "custom" && (e as { customType?: string }).customType === WATCH_ENTRY)
			.at(-1) as { data?: WatchSnapshot } | undefined;
		savedWatch = last?.data ? JSON.stringify(last.data) : "";
		if (last?.data) advisor.restoreWatch(last.data);
		checkState(); // baseline: what the session already knows at start
		if (configErrors.length > 0) ctx.ui.notify(`advisor config: ${configErrors.join("; ")}`, "warning");
		ctx.ui.setStatus("advisor", enabled ? "advisor on" : "advisor off");
	};

	pi.on("session_start", (_e, ctx) => start(ctx));

	pi.on("session_shutdown", () => {
		// ADVISOR_STATS_FILE: append one JSON line with the final counters (probes, cost tracking).
		const file = process.env.ADVISOR_STATS_FILE;
		if (file && advisor) appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), stats: advisor.ctx.stats, error: (advisor.ctx as { lastError?: string }).lastError, gate: advisor.gateCounts }) + "\n");
		advisor?.ctx.dispose?.();
	});

	// A note is only useful while the run it is about is still going; a late one is dropped, never queued for later.
	let run = 0;
	let running = false;
	pi.on("agent_start", () => {
		run++;
		running = true;
		advisor?.newRun();
	});
	// After each run: a task of the intent that got closed ends a piece of work, so the context may switch;
	// owner notes added meanwhile reach the session at its next turn instead of steering the running one.
	pi.on("agent_end", () => {
		running = false;
		checkState();
	});

	// The gate: runs before the final answer is stored and shown, so there is only ever one final answer.
	pi.on("message_end", async (e, ctx) => {
		lastCtx = ctx;
		const m = e.message as unknown as Msg;
		if (!advisor || !config || !enabled || !Advisor.isFinal(m)) return undefined;
		running = false; // a note arriving after the final answer would only start a pointless extra turn
		if (!config.gate.enabled) return undefined;
		const answer = Advisor.answerOf(m);
		answerBeingChecked = answer;
		try {
			ctx.ui.setStatus("advisor", "advisor checking…");
			const r = await advisor.gateFinal(answer);
			if (!r.changed || !Array.isArray(m.content)) return undefined;
			ctx.ui.notify("advisor: Antwort korrigiert, unbelegte Aussagen ersetzt", "info");
			const content = [...m.content];
			const first = content.findIndex((b) => b.type === "text");
			const kept = content.filter((b, i) => b.type !== "text" || i === first).map((b) => (b.type === "text" ? { ...b, text: r.text } : b));
			return { message: { ...(e.message as object), content: kept } as typeof e.message };
		} catch {
			return undefined; // fail open
		} finally {
			answerBeingChecked = undefined;
			ctx.ui.setStatus("advisor", "advisor on");
		}
	});

	// Observer: never blocks the agent. A note goes in as a steer message when the agent is still working.
	pi.on("turn_end", (e, ctx) => {
		lastCtx = ctx;
		const m = e.message as unknown as Msg;
		if (!advisor || !enabled || !Array.isArray(m.content) || !m.content.some((b) => b.type === "toolCall")) return;
		const a = advisor;
		const mine = run;
		void a
			.reviewTurn()
			.then((r) => {
				if (!r?.note || !running || run !== mine) return;
				pi.sendMessage({ customType: "advisor-note", content: `Advisor note: ${r.note}`, display: true }, { triggerTurn: false, deliverAs: "steer" });
			})
			.catch(() => undefined);
	});

	pi.registerCommand("advisor", {
		description: "advisor status | on | off | reset | stats",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0] || "status";
			if (!advisor || !config) start(ctx);
			if (!advisor || !config) return;
			if (sub === "on" || sub === "off") {
				enabled = sub === "on";
				ctx.ui.setStatus("advisor", enabled ? "advisor on" : "advisor off");
			} else if (sub === "reset") {
				advisor.ctx.reset();
			}
			const s = advisor.ctx.stats;
			const g = advisor.gateCounts;
			ctx.ui.notify(
				[
					`advisor ${enabled ? "on" : "off"} · ${config.model.provider}/${config.model.id} · ${config.agent.enabled ? "agent" : "bare call"} · gate ${config.gate.enabled ? "on" : "off"} · review every ${config.review.everyTurns} turns`,
					`calls ${s.calls} (failed ${s.failures}, resets ${s.resets}, tool calls ${s.toolCalls}) · cache hit ${pct(s.hitRate)} · in ${s.input} cacheRead ${s.cacheRead} cacheWrite ${s.cacheWrite} out ${s.output}`,
					`gate: released ${g.released} · checked ${g.checked} · unchecked ${g.unchecked} · proposals ${advisor.seen.size}`,
					...(configErrors.length ? [`config errors: ${configErrors.join("; ")}`] : []),
				].join("\n"),
				"info",
			);
		},
	});
}

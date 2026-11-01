import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ContextConfig, type ContextConfigInput, carriedTokens, resolveConfig } from "../core/config.ts";
import { requestShape } from "../core/continuity.ts";
import { type CutPlan, planCut } from "../core/cut.ts";
import {
	CUT_REQUEST_CHANNEL,
	KEEP_WARM_KIND,
	NOTEBOOK_KIND,
	REMINDER_KIND,
	SIGNALS_CHANNEL,
	SUMMARY_KIND,
	TASK_DONE_KIND,
} from "../core/kinds.ts";
import { GUIDANCE_SECTION, guidanceFor, notebookReminder, withSection } from "../core/guidance.ts";
import { selectChunk } from "../core/historian.ts";
import { type Answer, answerUsage, isRefused, Ledger, promptTokens, RequestTracker } from "../core/ledger.ts";
import {
	boundaryCut,
	type CacheTier,
	cacheTtlMs,
	type CutThresholds,
	cutAccepted,
	cutThresholds,
	projectedTokens,
	keepWarmDue,
	notebookReminderDue,
	promptCut,
} from "../core/policy.ts";
import { textOf } from "../core/messages.ts";
import { archivedReads, ContextSignals, type ContextSignalsEvent } from "../core/signals.ts";
import { estimateTokens } from "../core/tokens.ts";
import {
	answerSearch,
	checkNotebook,
	newestFirstPages,
	newestFirstPagesFrom,
	notebookView,
	readHistory,
	SCAN_PAGE,
	TOOLS,
} from "../core/tools.ts";
import { firstAnswer, historianFallbackModel, historianModel, summarizeWith } from "../historian/model.ts";
import { Historian, type HistorianBranch, type SummarizeRequest, type SummarizeResult } from "../historian/run.ts";
import { historyReadParameters, historySearchParameters, notebookParameters } from "../tools/schemas.ts";
import { type BranchState, readBranch } from "./branch.ts";
import { cacheCosts, KEEP_WARM_PING, readKeepWarmSignal, withoutPings } from "./keep-warm.ts";

/** The historian's model call in pi, which may use the session's context. */
export type Summarizer = (request: SummarizeRequest, ctx: ExtensionContext) => Promise<SummarizeResult>;

export interface ContextExtensionOptions {
	readonly config?: ContextConfigInput;
	/** JSON config file; defaults to `<agent dir>/sandy-context.json`. False skips it. */
	readonly configFile?: string | false;
	/** JSONL file with one record per provider request; defaults to `<agent dir>/sandy-context/ledger.jsonl`. False disables it. */
	readonly ledgerFile?: string | false;
	/** Clock for cache lifetime decisions. */
	readonly now?: () => number;
	/**
	 * Keep-warm pings. The signal file, `{ "until": <epoch ms> }`, says until when the session expects another prompt.
	 * It defaults to `pi-keep-warm.json` in the SANDY thread's storage (`SANDY_THREAD_STORAGE`), where a SANDY plugin on
	 * another machine can write it, else to `<agent dir>/sandy-context/keep-warm/<session id>.json`. False turns pings off.
	 */
	readonly keepWarm?: { readonly file?: string; readonly intervalMs?: number } | false;
	readonly summarize?: Summarizer;
}

function textResult<T>(text: string, details: T) {
	return { content: [{ type: "text" as const, text }], details };
}

function readConfigFile(path: string | false | undefined): ContextConfigInput | undefined {
	if (path === false) return undefined;
	const file = path ?? join(getAgentDir(), "sandy-context.json");
	if (!existsSync(file)) return undefined;
	return JSON.parse(readFileSync(file, "utf8")) as ContextConfigInput;
}

function defaultSummarizer(config: ContextConfig): Summarizer {
	const configured = historianModel(config);
	const fallbackRef = historianFallbackModel(config);
	return async (request, ctx) => {
		const model = (configured && ctx.modelRegistry.find(configured.provider, configured.id)) ?? ctx.model;
		const fallback = fallbackRef && ctx.modelRegistry.find(fallbackRef.provider, fallbackRef.id);
		const models = [model, fallback].filter(
			(candidate, index, all): candidate is NonNullable<typeof candidate> =>
				candidate !== undefined && all.findIndex((other) => other === candidate) === index,
		);
		return firstAnswer(
			models.map(
				(candidate) => () =>
					summarizeWith(
						// streamSimple, not complete: only it maps the reasoning option, and without it the
						// provider's default thinking spends the output limit.
						(context, options) =>
							ctx.modelRegistry
								.streamSimple(candidate, context, { ...options, sessionId: randomUUID() })
								.result(),
						candidate,
						request,
					),
			),
			request.signal,
		);
	};
}

/**
 * Pi extension for indefinitely long sessions.
 *
 * The session file stays the only source of truth and only ever grows. Each cut is one
 * native pi compaction entry built without a model call; pi's own projection then yields
 * the model view. Cuts happen only where the prompt cache is lost anyway (cold cache,
 * model change, pi's own compaction) or at the planned watermark.
 */
export function createContextExtension(options: ContextExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return function sandyContext(pi: ExtensionAPI): void {
		const config = resolveConfig(readConfigFile(options.configFile), options.config);
		const now = options.now ?? Date.now;
		const summarize = options.summarize ?? defaultSummarizer(config);

		let ledger = new Ledger();
		let ledgerFile: string | undefined;
		let sessionId = "";
		let requests = new RequestTracker();
		/** Reason for the cache break the next request will show. */
		let pendingCut: string | undefined;
		/** Where the pending cut happened: between two requests of a run, before a prompt, or for pi's own compaction. */
		let pendingPosition: "run" | "prompt" | "pi" | undefined;
		/** Tool output, delegation and after-cut signals for the ledger. */
		let signals = new ContextSignals();
		/** Files the latest cut archived, computed once per cut. */
		let archived: { from: number; paths: Set<string> } | undefined;
		/** Size problems reported to the user in this session, by kind; the ledger keeps every one. */
		let sizeReported = new Set<string>();
		/** The latest size problem, for `/sandy-context`. */
		let lastSizeProblem: string | undefined;
		/** Reason for the compaction the input handler is waiting for. */
		let promptReason: "watermark" | "cold" | "model" | "task" | undefined;
		/** A task finished since the last cut chance; the next one cuts if the context is large enough. */
		let taskDone = false;
		pi.events.on(CUT_REQUEST_CHANNEL, (data) => {
			taskDone = true;
			// Kept in the log: under SANDY the next prompt is handled by a new process.
			pi.appendEntry(TASK_DONE_KIND, data ?? {});
		});
		/** Whether a finished task asks for a cut at this chance; the request is used up either way. */
		const taskCut = (tokens: number | undefined): boolean => {
			const due = taskDone && tokens !== undefined && tokens >= config.taskCutMinTokens;
			taskDone = false;
			return due;
		};
		/** Whether the agent can write its notebook in the current run; reminders are pointless otherwise. */
		let notebookAvailable = true;
		const historian = new Historian<string>(config);
		/** The newest context, for the keep-warm timer, and the timer itself. */
		let idleContext: ExtensionContext | undefined;
		let keepWarmTimer: ReturnType<typeof setInterval> | undefined;
		const tier = (): CacheTier => (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");

		const branchOf = (ctx: ExtensionContext): BranchState => readBranch(ctx.sessionManager.getBranch());
		const thresholdsFor = (ctx: ExtensionContext): CutThresholds => cutThresholds(config, ctx.model?.contextWindow);
		const planFrom = (state: BranchState, reason: string): CutPlan | undefined =>
			planCut({
				entries: state.entries,
				minKeptIndex: state.minKeptIndex,
				visibleFromIndex: state.visibleFromIndex,
				summary: state.summary,
				notebook: state.notebook,
				config,
				reason,
			});

		/**
		 * Tells the user about a cut that misses its limit, once per session and kind. Without a UI (print mode) the
		 * text goes to stderr; the latest one is shown by `/sandy-context`.
		 */
		function reportSize(ctx: ExtensionContext, kind: string, text: string): void {
			lastSizeProblem = `${new Date(now()).toISOString()}: ${text}`;
			if (sizeReported.has(kind)) return;
			sizeReported.add(kind);
			if (ctx.hasUI) ctx.ui.notify(text, "warning");
			else console.error(text);
		}

		const SIZE_ADVICE = "raise watermarkTokens, or lower keepRecentTokens, maskedTokens, pinnedUserTokens or summaryTokens";

		/**
		 * The cut for `reason`, when `cutAccepted` takes it: it brings the prompt below `limit`, or the prompt has
		 * reached `hard` and the cut frees a quarter of it. Any other cut is refused, logged and reported: cutting again
		 * and again would not help.
		 */
		function shrinkingPlan(
			ctx: ExtensionContext,
			state: BranchState,
			reason: string,
			tokens: number | undefined,
			limit: number | undefined,
			hard: number,
		): CutPlan | undefined {
			const plan = planFrom(state, reason);
			if (!plan || tokens === undefined || limit === undefined) return plan;
			const kept = state.entries.findIndex((entry) => entry.id === plan.firstKeptEntryId);
			if (kept < 0) return plan;
			const archivedTokens = state.entries
				.slice(state.visibleFromIndex, kept)
				.reduce((sum, entry) => sum + entry.tokens, 0);
			const size = {
				contextTokens: tokens,
				visibleTokens: state.visibleTokens,
				archivedTokens,
				blockTokens: plan.details.blockTokens,
				limit,
			};
			if (cutAccepted(size, hard)) return plan;
			const projected = Math.round(projectedTokens(size));
			writeLedger({
				t: new Date(now()).toISOString(),
				session: sessionId,
				class: "cut-refused",
				reason,
				tokens,
				limit,
				projected,
				hard,
			});
			const count = (value: number) => `~${Math.round(value).toLocaleString("en-US")}`;
			reportSize(
				ctx,
				"refused",
				tokens < hard
					? `sandy-context: a ${reason} cut would leave ${count(projected)} tokens, not below ${count(limit)}, so it waits until the prompt reaches ${count(hard)}. To cut at the watermark, ${SIZE_ADVICE}.`
					: `sandy-context: at ${count(tokens)} tokens a ${reason} cut would free too little (to ${count(projected)}). The prompt keeps growing; ${SIZE_ADVICE}.`,
			);
			return undefined;
		}

		function writeLedger(record: Record<string, unknown>): void {
			if (!ledgerFile) return;
			try {
				mkdirSync(dirname(ledgerFile), { recursive: true });
				appendFileSync(ledgerFile, `${JSON.stringify(record)}\n`);
			} catch {
				ledgerFile = undefined;
			}
		}

		/** The session's branch for the background historian, which summarizes what the next cut will archive. */
		function historianBranch(ctx: ExtensionContext): HistorianBranch {
			return {
				summarize: (request) => summarize(request, ctx),
				next: async () => {
					const state = branchOf(ctx);
					// History archived by someone else's compaction stays searchable only; our own cuts are summarized later.
					const floor = state.summary ? 0 : state.historianFloorIndex;
					const chunk = selectChunk(state.entries, state.summary, config, floor);
					return chunk && { summary: state.summary, chunk };
				},
				latest: async (anchor) => {
					const current = branchOf(ctx);
					return { summary: current.summary, holds: current.entries.some((entry) => entry.id === anchor) };
				},
				write: async (summary) => {
					pi.appendEntry(SUMMARY_KIND, summary);
				},
			};
		}

		/**
		 * Summaries pay off only for history a cut archives, so a session starts summarizing once its prompt reaches
		 * `historian.startTokens`, or once it has been cut or summarized already.
		 */
		function scheduleHistorian(ctx: ExtensionContext): void {
			const tokens = ctx.getContextUsage()?.tokens ?? 0;
			if (tokens < config.historian.startTokens) {
				const state = branchOf(ctx);
				if (!state.summary && state.cuts === 0) return;
			}
			historian.schedule(sessionId, historianBranch(ctx));
		}

		function archivedPaths(ctx: ExtensionContext): Set<string> {
			const state = branchOf(ctx);
			if (archived?.from !== state.visibleFromIndex) {
				archived = { from: state.visibleFromIndex, paths: archivedReads(state.entries, state.visibleFromIndex) };
			}
			return archived.paths;
		}

		function signalLine(signal: ReturnType<ContextSignals["snapshot"]>): string {
			const sinceCut =
				signal.requestsSinceCut === undefined
					? "no cut seen yet"
					: `${signal.historyCallsSinceCut} history calls and ${signal.rereadsSinceCut} re-reads of archived files in ${signal.requestsSinceCut} requests since the latest cut`;
			return `Tools this run: ~${signal.runToolTokens.toLocaleString("en-US")} output tokens, ${signal.delegations} delegations; ${sinceCut}`;
		}

				function statusLines(ctx: ExtensionContext): string[] {
			const state = branchOf(ctx);
			const tokens = ctx.getContextUsage()?.tokens;
			const summaryItems = state.summary
				? Object.values(state.summary.sections).reduce((sum, items) => sum + items.length, 0)
				: 0;
			const notebookBytes = Buffer.byteLength(state.notebook ?? "", "utf8");
			return [
				`Prompt: ${tokens == null ? "unknown until the next response" : `~${tokens.toLocaleString("en-US")}`} tokens; cut before the next prompt from ${thresholdsFor(ctx).soft.toLocaleString("en-US")}, mid-run from ${thresholdsFor(ctx).hard.toLocaleString("en-US")}, or on a cold cache above ${config.coldCutMinTokens.toLocaleString("en-US")}`,
				`Cuts on this branch: ${state.cuts}; summary ${state.summary ? `through #${state.summary.coveredThroughId}, ${summaryItems} items` : "not started"}; notebook ${notebookBytes} bytes`,
				`Historian: ${historian.stats.runs} runs, ${historian.stats.condensed} condensations, ${historian.stats.failures} failures${historian.stats.lastError ? ` (last: ${historian.stats.lastError})` : ""}${historian.running > 0 ? ", running" : ""}`,
				signalLine(signals.snapshot()),
				`Cut size: ${lastSizeProblem ?? "no refused or oversized cut in this session"}`,
				`Log: ${state.entries.length.toLocaleString("en-US")} entries, ${state.visibleFromIndex.toLocaleString("en-US")} archived and searchable`,
				...ledger.report(),
			];
		}

		pi.on("session_start", (_event, ctx) => {
			void historian.stop();
			historian.start();
			ledger = new Ledger();
			requests = new RequestTracker();
			pendingCut = undefined;
			pendingPosition = undefined;
			archived = undefined;
			signals = new ContextSignals();
			const start = branchOf(ctx);
			if (start.cuts > 0) signals.resume(start.entries, start.minKeptIndex, start.visibleFromIndex);
			promptReason = undefined;
			sizeReported = new Set();
			lastSizeProblem = undefined;
			taskDone = readBranch(ctx.sessionManager.getBranch()).taskCutPending;
			sessionId = ctx.sessionManager.getSessionId();
			ledgerFile =
				options.ledgerFile === false
					? undefined
					: (options.ledgerFile ?? join(getAgentDir(), "sandy-context", "ledger.jsonl"));
			scheduleHistorian(ctx);
			idleContext = ctx;
			startKeepWarm();
		});

		function startKeepWarm(): void {
			clearInterval(keepWarmTimer);
			if (options.keepWarm === false) return;
			const settings = options.keepWarm ?? {};
			const threadStorage = process.env.SANDY_THREAD_STORAGE;
			const file =
				settings.file ??
				(threadStorage
					? join(threadStorage, "pi-keep-warm.json")
					: join(getAgentDir(), "sandy-context", "keep-warm", `${sessionId}.json`));
			keepWarmTimer = setInterval(() => {
				try {
					keepWarm(file);
				} catch {
					// The session was replaced or disposed without a shutdown event; its context is stale.
					clearInterval(keepWarmTimer);
					idleContext = undefined;
				}
			}, settings.intervalMs ?? 30_000);
			// A waiting session must not keep a finished process (pi -p) alive.
			keepWarmTimer.unref?.();
		}

		/** One timer tick: ping when a prompt is expected after the cache expires and keeping it warm is cheaper. */
		function keepWarm(file: string): void {
			const ctx = idleContext;
			if (!ctx?.isIdle()) return;
			const until = readKeepWarmSignal(file);
			if (until === undefined) return;
			// The next prompt cuts anyway; a warm cache would be thrown away.
			const tokens = ctx.getContextUsage()?.tokens ?? undefined;
			if (tokens !== undefined && tokens >= thresholdsFor(ctx).soft) return;
			const state = branchOf(ctx);
			const costs = cacheCosts(ctx.model, tier());
			const due = keepWarmDue({
				now: now(),
				lastCacheTouch: state.lastCacheTouch,
				ttlMs: cacheTtlMs(config, ctx.model, tier()),
				until,
				contextTokens: tokens,
				minTokens: config.coldCutMinTokens,
				carriedTokens: carriedTokens(config),
				cacheReadCost: costs.read,
				cacheWriteCost: costs.write,
			});
			if (!due) return;
			writeLedger({ t: new Date(now()).toISOString(), session: sessionId, class: "keep-warm", until });
			pi.sendMessage({ customType: KEEP_WARM_KIND, content: KEEP_WARM_PING, display: false }, { triggerTurn: true });
		}

		function settleRequest(message: Answer, ctx: ExtensionContext): void {
			const reason = pendingCut;
			const position = pendingPosition;
			const judged = requests.settle(isRefused(message), reason);
			if (!judged) return;
			const planned = judged.requestClass === "planned";
			// A planned cut stays pending until a request carrying it is accepted.
			if (judged.requestClass !== "rejected") {
				pendingCut = undefined;
				pendingPosition = undefined;
			}
			const usage = answerUsage(message);
			const signal = signals.request();
			if (planned) signals.cut();
			const prompt = promptTokens(usage);
			const soft = thresholdsFor(ctx).soft;
			if (planned && prompt >= soft) {
				reportSize(
					ctx,
					"oversized",
					`sandy-context: after a ${reason ?? "planned"} cut the prompt is ~${prompt.toLocaleString("en-US")} tokens, at or above the watermark ${soft.toLocaleString("en-US")}. Watermark cuts are refused until the hard threshold; ${SIZE_ADVICE}.`,
				);
			}
			ledger.record(judged.requestClass, reason);
			writeLedger({
				t: new Date(now()).toISOString(),
				session: sessionId,
				class: judged.requestClass,
				...(reason !== undefined && planned ? { reason, ...(position ? { position } : {}) } : {}),
				...(judged.continuity.kind === "broken" ? { at: judged.continuity.at } : {}),
				items: judged.items,
				model: judged.model,
				prompt,
				usage,
				signals: signal,
			});
		}

		pi.on("context", (event) => {
			const messages = withoutPings(event.messages);
			return messages.length === event.messages.length ? undefined : { messages };
		});

		pi.on("session_shutdown", () => {
			clearInterval(keepWarmTimer);
			idleContext = undefined;
			return historian.stop();
		});

		pi.on("session_tree", () => {
			pendingCut ??= "branch";
		});

		pi.on("agent_start", () => {
			signals.startRun();
		});

		// Every tool result, also those of calls made inside another tool; only top-level results reach the prompt.
		pi.on("tool_result", (event, ctx) => {
			const content = event.content as unknown;
			signals.observe(
				{
					name: event.toolName,
					input: event.input,
					outputTokens: event.parentToolCallId ? 0 : estimateTokens(textOf(content)),
				},
				(path) => archivedPaths(ctx).has(path),
			);
			return undefined;
		});

		// Cache continuity on the payload the provider receives, judged once the provider answered.
		pi.on("before_provider_request", (event, ctx) => {
			const shape = requestShape(event.payload);
			if (!shape) return undefined;
			requests.begin(shape, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			return undefined;
		});

		pi.on("message_end", (event, ctx) => {
			const message = event.message as Answer & { role?: string };
			if (message.role !== "assistant") return undefined;
			settleRequest(message, ctx);
			if (message.usage) ledger.addUsage(answerUsage(message));
			return undefined;
		});

		// Constant guidance as its own prompt section: it enters the cached prefix once and never changes.
		// When an earlier handler forced the prompt (an extension can), pi ignores sections, so the
		// guidance is appended to the forced text instead.
		pi.on("before_agent_start", (event) => {
			const options = event.systemPromptOptions;
			const guidance = guidanceFor(options.selectedTools, options.hiddenTools);
			notebookAvailable = guidance !== undefined;
			if (guidance) options.sections[GUIDANCE_SECTION] = guidance;
			else delete options.sections[GUIDANCE_SECTION];
			if (guidance && options.forceSystemPrompt !== undefined) {
				return { systemPrompt: withSection(options.forceSystemPrompt, GUIDANCE_SECTION, guidance) };
			}
			return undefined;
		});

		// Planned cut between two requests of a run: at the hard threshold, at the soft one when no user prompt will come
		// to cut at (no UI, or the next prompt is already queued), or after a finished task. Before that, a notebook reminder.
		pi.on("turn_end", (event, ctx) => {
			scheduleHistorian(ctx);
			if (event.outcome !== "completed" || event.entries.some((entry) => entry.type === "compaction")) return undefined;
			const tokens = ctx.getContextUsage()?.tokens ?? estimateTokens(JSON.stringify(event.context.llmMessages));
			const thresholds = thresholdsFor(ctx);
			const published: ContextSignalsEvent = { sessionId, contextTokens: tokens, ...thresholds, ...signals.snapshot() };
			pi.events.emit(SIGNALS_CHANNEL, published);
			const deferToPrompt = ctx.hasUI && !ctx.hasPendingMessages();
			const task = taskCut(tokens);
			const reason = boundaryCut(tokens, thresholds, deferToPrompt) ? "watermark" : task ? "task" : undefined;
			if (!reason) {
				if (!notebookAvailable) return undefined;
				const state = branchOf(ctx);
				const due = notebookReminderDue({
					contextTokens: tokens,
					watermark: thresholds.soft,
					at: config.notebookReminderAt,
					notebookCurrent: state.notebookCurrent,
					reminded: state.reminded,
				});
				if (!due) return undefined;
				return {
					entries: [
						...event.entries,
						{
							type: "custom_message" as const,
							customType: REMINDER_KIND,
							content: notebookReminder(
								Math.max(0, (tokens >= thresholds.soft ? thresholds.hard : thresholds.soft) - tokens),
								(state.notebook ?? "") === "",
							),
							display: false,
						},
					],
				};
			}
			const plan = shrinkingPlan(
				ctx,
				branchOf(ctx),
				reason,
				tokens,
				reason === "watermark" ? thresholds.soft : tokens,
				thresholds.hard,
			);
			if (!plan) return undefined;
			pendingCut = reason;
			pendingPosition = "run";
			return {
				entries: [
					...event.entries,
					{
						type: "compaction" as const,
						summary: plan.text,
						firstKeptEntryId: plan.firstKeptEntryId,
						details: { sandyContext: plan.details },
					},
				],
			};
		});

		// Before a new prompt: use a cache that is lost anyway (expired, or another model), or a finished task, for a cut.
		pi.on("input", async (event, ctx) => {
			if (event.streamingBehavior !== undefined || !ctx.isIdle()) return { action: "continue" as const };
			const state = branchOf(ctx);
			if (state.endsWithCompaction) return { action: "continue" as const };
			const tokens = ctx.getContextUsage()?.tokens ?? undefined;
			const { soft, hard } = thresholdsFor(ctx);
			const prompt = promptCut({
				contextTokens: tokens,
				now: now(),
				lastCacheTouch: state.lastCacheTouch,
				ttlMs: cacheTtlMs(config, ctx.model, tier()),
				modelKey: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				lastModelKey: state.lastModelKey,
				minTokens: config.coldCutMinTokens,
				soft,
			});
			const task = taskCut(tokens);
			const reason = prompt ?? (task ? "task" : undefined);
			if (!reason || !shrinkingPlan(ctx, state, reason, tokens, reason === "watermark" ? soft : tokens, hard)) {
				return { action: "continue" as const };
			}
			promptReason = reason;
			await new Promise<void>((resolve) => {
				ctx.compact({
					onComplete: () => resolve(),
					onError: () => {
						promptReason = undefined;
						resolve();
					},
				});
			});
			return { action: "continue" as const };
		});

		// Every compaction pi starts on its own (threshold, overflow, /compact) becomes our cut, instantly.
		pi.on("session_before_compact", (event) => {
			const position = event.reason === "manual" && promptReason ? "prompt" : "pi";
			const reason = event.reason === "manual" ? (promptReason ?? "manual") : event.reason;
			const plan = planFrom(readBranch(event.branchEntries), reason);
			if (!plan) return undefined;
			promptReason = undefined;
			taskDone = false;
			pendingCut = reason;
			pendingPosition = position;
			return {
				compaction: {
					summary: plan.text,
					firstKeptEntryId: plan.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: { sandyContext: plan.details },
				},
			};
		});

		pi.on("session_compact_failed", () => {
			pendingCut = undefined;
			pendingPosition = undefined;
			promptReason = undefined;
		});

		pi.registerTool({
			...TOOLS.historySearch,
			parameters: historySearchParameters,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { entries, visibleFromIndex } = branchOf(ctx);
				const archived = new Set(entries.slice(0, visibleFromIndex).map((entry) => entry.id));
				const pages = () => newestFirstPages(entries, SCAN_PAGE, params.cursor);
				const from = (id: string) => newestFirstPagesFrom(entries, id);
				const reply = await answerSearch(
					pages,
					from,
					params,
					visibleFromIndex > 0 ? (id) => archived.has(id) : undefined,
				);
				return textResult(reply.text, { hits: reply.hits });
			},
		});

		pi.registerTool({
			...TOOLS.historyRead,
			parameters: historyReadParameters,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const read = readHistory(branchOf(ctx).entries, params);
				return textResult(read.text, { id: read.id });
			},
		});

		pi.registerTool({
			...TOOLS.notebook,
			parameters: notebookParameters,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (params.text === undefined) return textResult(notebookView(branchOf(ctx).notebook ?? ""), undefined);
				const check = checkNotebook(params.text, config.notebookMaxBytes);
				if (!check.ok) throw new Error(check.message);
				pi.appendEntry(NOTEBOOK_KIND, { text: params.text });
				return textResult(check.message, undefined);
			},
		});

		pi.registerCommand("sandy-context", {
			description: "Show context management status: prompt size, cuts, summary and cache continuity",
			handler: async (_args, ctx) => {
				ctx.ui.notify(statusLines(ctx).join("\n"), "info");
			},
		});
	};
}

export default createContextExtension();

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Api, AssistantMessage, Model, ToolResultMessage } from "@earendil-works/pi-ai";
import * as piHost from "@earendil-works/pi-coding-agent";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type ContextConfigInput, isConfigErrors } from "../core/config.ts";
import { requestShape } from "../core/continuity.ts";
import { ATTEMPT_KIND, CUT_REQUEST_CHANNEL, NOTEBOOK_KIND, RETRIEVAL_KIND, SIGNALS_CHANNEL, SUMMARY_KIND } from "../core/kinds.ts";
import { GUIDANCE_SECTION, guidanceFor, withSection } from "../core/guidance.ts";
import { commitSummary, evidenceBudget, selectEvidence } from "../core/historian.ts";
import { type Answer, answerUsage, isRefused, Ledger, promptTokens, RequestTracker } from "../core/ledger.ts";
import { type CacheTier, cacheTtlMs } from "../core/policy.ts";
import { textOf } from "../core/messages.ts";
import { ContextSignals, type ContextSignalsEvent } from "../core/signals.ts";
import { accountingEvents, formatCostReport, reduceAccounting } from "../core/accounting.ts";
import { formatCapShadowReport, reduceCapShadow } from "../core/kept-cap.ts";
import { formatRetrievalReport, reduceRetrieval, retrievalEvents } from "../core/retrieval.ts";
import { mergeEntries, type RawEntry } from "../core/session-entries.ts";
import { estimateTokens } from "../core/tokens.ts";
import {
	checkNotebook,
	notebookView,
	TOOLS,
} from "../core/tools.ts";
import { isModelError, refusedTransport, type ResolvedPolicy, resolveHistorianModels } from "../historian/model.ts";
import {
	type HistorianBranch,
	HistorianLifecycle,
	type SummarizeRequest,
	type SummarizeResult,
} from "../historian/run.ts";
import { historyReadParameters, historySearchParameters, notebookParameters } from "../tools/schemas.ts";
import { type SessionProjector, SessionTape } from "./session.ts";
import { CutController } from "./cuts.ts";
import { CapturePool } from "./captures.ts";
import { HistorianRequests, type IsolatedModel } from "./historian.ts";
import { configFailure, keptCapEvidence, keptCapGate, loadConfig } from "./config.ts";
import { migrateHostFiles } from "./migrate.ts";
import { checkHost, detectCapabilities, gatedApi } from "./host.ts";
import { CompetitorWarnings, observeOwners, type WarningEvidence } from "./coexist.ts";
import { decodeContextRecord } from "../core/records.ts";
import { type KEEP_WARM_FILE, KeepWarm, withoutPings } from "./keep-warm.ts";
import { SessionClaim } from "./claim.ts";
import { SessionFileTail, SessionReceipts } from "./session-attempts.ts";

/** The historian's model call in pi, which may use the session's context. */
export type Summarizer = (request: SummarizeRequest, ctx: ExtensionContext) => Promise<SummarizeResult>;

export interface ContextExtensionOptions {
	readonly config?: ContextConfigInput;
	/** JSON config file; defaults to `<agent dir>/context.json`. False skips it. */
	readonly configFile?: string | false;
	/** JSONL file with one record per provider request; defaults to `<agent dir>/context/ledger.jsonl`. False disables it. */
	readonly ledgerFile?: string | false;
	/** Clock for cache lifetime decisions. */
	readonly now?: () => number;
	/**
	 * Keep-warm pings. The signal file, `{ "until": <epoch ms> }`, says until when the session expects another prompt.
	 * It defaults to {@link KEEP_WARM_FILE} in the Sandy thread's storage (`SANDY_THREAD_STORAGE`, see `signalFile`), where a Sandy plugin on
	 * another machine can write it, else to `<agent dir>/context/keep-warm/<session id>.json`. False turns pings off.
	 */
	readonly keepWarm?: { readonly file?: string; readonly intervalMs?: number } | false;
	readonly summarize?: Summarizer;
	/**
	 * The probe record that lets `keptCap.mode` "on" start; defaults to `context-kept-cap-probe.json` in the agent
	 * directory. False names none. Read only in mode "on".
	 */
	readonly keptCapProbeFile?: string | false;
}

function textResult<T>(text: string, details: T) {
	return { content: [{ type: "text" as const, text }], details };
}

/**
 * The historian's isolated routes: the configured models, else the session's own model, then the fallback. A model
 * whose client resends unseen is not asked.
 */
function historianModels(policy: ResolvedPolicy<Model<Api>>, ctx: ExtensionContext): IsolatedModel[] {
	const candidates = [
		{ route: "primary", model: policy.primary ?? ctx.model },
		{ route: "fallback", model: policy.fallback },
	];
	return candidates.flatMap(({ route, model }, index) => {
		if (model === undefined || candidates.findIndex((other) => other.model === model) !== index) return [];
		if (refusedTransport(model)) return [];
		return [{ route, model }];
	});
}

/**
 * Why the session has no historian: no historian model is set and the session's model is one the historian refuses,
 * or undefined when it has one.
 */
function historianUnavailable(policy: ResolvedPolicy<Model<Api>>, ctx: ExtensionContext): string | undefined {
	if (policy.primary !== undefined || policy.fallback !== undefined || ctx.model === undefined) return undefined;
	const refused = refusedTransport(ctx.model);
	return refused
		? `the session model ${ctx.model.provider}/${ctx.model.id} ${refused}. Set historian.model to a model on another API; until then no summaries are made`
		: undefined;
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
	return function contextExtension(host: ExtensionAPI): void {
		// A host or a config that cannot work stops here, before anything is registered.
		const hostCheck = checkHost(detectCapabilities(host, piHost));
		if (!hostCheck.supported) throw new Error(hostCheck.message);
		// The host files named before the rename move once, before the config is read from its new name. Only a config
		// conflict stops the load; a ledger directory left under its old name is a warning. A start given its own config
		// file, or none, leaves the host's config file alone.
		const migration = migrateHostFiles(getAgentDir(), undefined, { config: options.configFile === undefined });
		if (migration.status === "conflict") throw new Error(migration.message);
		let migrationNotices: { text: string; level: "info" | "warning" }[] = [];
		if (migration.status === "moved") {
			migrationNotices.push({ text: `context: moved the files named before the rename: ${migration.moved.join(", ")}`, level: "info" });
		}
		if (migration.warning !== undefined) migrationNotices.push({ text: migration.warning, level: "warning" });
		const loaded = loadConfig(options.configFile, options.config);
		if (isConfigErrors(loaded)) throw configFailure(loaded);
		const config = loaded;
		const gate = keptCapGate(config, options.keptCapProbeFile);
		if (gate) throw configFailure(gate);
		/**
		 * Why the cap may not shape a cut for this session's model, none when the probe record on disk covers it. The
		 * record is read again at every cut that would use the cap: the startup gate sees no model, and a record that
		 * was overwritten or a model that was switched since must not keep the cap on. Other modes never read it.
		 */
		const capEvidence = (ctx: ExtensionContext): string | undefined => {
			if (config.keptCap.mode !== "on") return undefined;
			if (!ctx.model) return "the session has no model yet";
			const { verdict, where } = keptCapEvidence(config, options.keptCapProbeFile, `${ctx.model.provider}/${ctx.model.id}`);
			return verdict.ok ? undefined : `${verdict.kind}: ${verdict.reason} (${where})`;
		};
		const now = options.now ?? Date.now;
		/** Tells the user: in the UI when there is one, else on stderr (print and json mode). */
		const tell = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error"): void => {
			if (ctx.hasUI) ctx.ui.notify(text, level);
			else console.error(text);
		};
		let policy: ResolvedPolicy<Model<Api>> = { primary: undefined, fallback: undefined };

		// Models can only be looked up once pi has a registry, at session start. Until that check passes, the hooks,
		// tools and the command registered below do nothing.
		let ready = false;
		let startupError = "";
		const pi = gatedApi(host, () => ready, () => startupError);
		host.on("session_start", (_event, ctx) => {
			ready = false;
			for (const { text, level } of migrationNotices) tell(ctx, text, level);
			migrationNotices = [];
			if (options.summarize === undefined && config.historian.enabled) {
				const resolved = resolveHistorianModels(config, ctx.modelRegistry);
				if (isModelError(resolved)) {
					startupError = `pi-context: ${resolved.modelError}. Fix or remove it in the settings file.`;
					ctx.shutdown();
					throw new Error(startupError);
				}
				policy = resolved;
			}
			ready = true;
		});
		// A host without a shutdown handler (print and json mode) goes on after a failed start: refuse its prompts.
		host.on("input", (_event, ctx) => {
			if (ready || startupError === "") return { action: "continue" as const };
			tell(ctx, `${startupError} The prompt was not sent.`, "error");
			return { action: "handled" as const };
		});

		let ledger = new Ledger();
		let ledgerFile: string | undefined;
		let sessionId = "";
		let requests = new RequestTracker();
		/** The main requests a summary may fork from and a ping replays, with the one cache clock of their prefix. */
		const captures = new CapturePool();
		/** The historian's model requests. */
		const historianRequests = new HistorianRequests({
			captures,
			fork: config.historian.fork,
			now,
			record: (record) => writeLedger({ t: new Date(now()).toISOString(), session: sessionId, class: "historian-route", ...record }),
		});
		/** Tool output, delegation and after-cut signals for the ledger. */
		let signals = new ContextSignals();
		/** The historian's receipts in the session file, as every process on it wrote them. */
		let fileReceipts: { readonly file: string; readonly receipts: SessionReceipts } | undefined;
		/** The receipts of a session without a file: this process's own records. */
		const memoryReceipts = new SessionReceipts(undefined);
		/** The claim on the historian's work in the session file. */
		const historianClaim = new SessionClaim("historian");
		/** The session file's entries, for the reports. */
		let fileEntries: { readonly file: string; readonly tail: SessionFileTail<RawEntry> } | undefined;
		/** The tape of the session's manager, which takes new entries in from the tail instead of reading the branch again. */
		let followed: { manager: ExtensionContext["sessionManager"]; tape: SessionTape } | undefined;
		/** Size problems reported to the user in this session, by kind; the ledger keeps every one. */
		let sizeReported = new Set<string>();
		/** Why the historian is unavailable, as the user was told in this session. */
		let unavailableReported = new Set<string>();
		/** Other compacting extensions the user was told about in this session. */
		let competitors = new CompetitorWarnings();
		/** The latest size problem, for `/context`. */
		let lastSizeProblem: string | undefined;
		/** Whether the agent can write its notebook in the current run; reminders are pointless otherwise. */
		let notebookAvailable = true;
		/** Each session start and branch change begins a generation; the historian's worker belongs to one generation. */
		let generation = 0;
		/** The context the historian's worker was last scheduled with, to tell the owner about a pause. */
		let historianContext: ExtensionContext | undefined;
		const historian = new HistorianLifecycle(config, {
			now,
			onPause: (pause) => {
				const text = `Historian paused after ${pause.attempts} failed attempts${pause.lastDetail ? ` (last: ${pause.lastDetail})` : ""}. No more summaries are requested until you run /context retry-historian.`;
				if (historianContext) tell(historianContext, text, "warning");
				else console.error(text);
			},
		});
		const tier = (): CacheTier => (process.env.PI_CACHE_RETENTION === "long" ? "long" : "short");

		// The host check refuses a pi without buildSessionProjection, so the extension never runs without it.
		const project = piHost.buildSessionProjection as SessionProjector;
		const tapeOf = (ctx: ExtensionContext): SessionTape => {
			if (followed?.manager !== ctx.sessionManager) {
				followed = { manager: ctx.sessionManager, tape: SessionTape.follow(ctx.sessionManager, project, config) };
			} else followed.tape.refresh();
			return followed.tape;
		};
		const cuts = new CutController({
			config,
			pi,
			project,
			now,
			tier,
			ledger: (record) => writeLedger({ ...record, session: sessionId }),
			report: reportSize,
			notebookAvailable: () => notebookAvailable,
			competing: () => competitors.active,
			capEvidence,
		});
		const keepWarm = new KeepWarm({ config, pi, captures, now, settings: options.keepWarm, tier, softTokens: (ctx) => cuts.thresholds(ctx).soft });
		pi.events.on(CUT_REQUEST_CHANNEL, (data) => {
			if (!ready) return;
			cuts.requestTask(data);
		});
		/**
		 * Tells the user about a cut that misses its limit, once per session and kind. Without a UI (print mode) the
		 * text goes to stderr; the latest one is shown by `/context`.
		 */
		function reportSize(ctx: ExtensionContext, kind: string, text: string): void {
			lastSizeProblem = `${new Date(now()).toISOString()}: ${text}`;
			if (sizeReported.has(kind)) return;
			sizeReported.add(kind);
			tell(ctx, text, "warning");
		}

		/** Tells the user, once per reason, what shows another extension also compacts this session. */
		function warnCompetitors(ctx: ExtensionContext, evidence: readonly WarningEvidence[]): void {
			for (const text of competitors.fresh(evidence)) tell(ctx, text, "warning");
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

		/** The historian's receipts of every pi process on the session file; this process's alone for a session without a file. */
		function receiptsOf(file: string | undefined): SessionReceipts {
			if (file === undefined) return memoryReceipts;
			if (fileReceipts?.file !== file) fileReceipts = { file, receipts: new SessionReceipts(file) };
			return fileReceipts.receipts;
		}

		/** The session's branch for the background historian, which summarizes what the next cut will archive. */
		function historianBranch(ctx: ExtensionContext): HistorianBranch {
			historianContext = ctx;
			const file = ctx.sessionManager.getSessionFile();
			const claim = historianClaim.claimFor(file);
			// Every receipt of the session, see session-attempts.ts: the file's, then this process's the file lacks.
			const receipts = () => receiptsOf(file).read(ctx.sessionManager.getEntries());
			return {
				attempts: {
					read: () => receipts().unfinished,
					stored: (key) => receipts().stored.has(key),
					append: (entry) => pi.appendEntry(ATTEMPT_KIND, entry),
				},
				...(claim ? { claim } : {}),
				routes: () => {
					const injected = options.summarize;
					if (injected) return [{ route: "primary", model: "injected", call: (request: SummarizeRequest) => injected(request, ctx) }];
					const unavailable = historianUnavailable(policy, ctx);
					if (unavailable !== undefined && !unavailableReported.has(unavailable)) {
						unavailableReported.add(unavailable);
						tell(ctx, `Historian unavailable: ${unavailable}.`, "warning");
					}
					return historianRequests.routes({
						// streamSimple, not complete: only it maps the reasoning option, and without it the provider's
						// default thinking spends the output limit.
						send: (model, context, requestOptions) => ctx.modelRegistry.streamSimple(model, context, requestOptions).result(),
						main: ctx.model,
						isolated: historianModels(policy, ctx),
						cacheTtlMs: ctx.model ? cacheTtlMs(config, ctx.model, tier()) : 0,
						sessionId,
					});
				},
				next: async () => {
					// The history leaves out what someone else's compaction archived; our own cuts are summarized later.
					const tape = tapeOf(ctx);
					const history = tape.history();
					return selectEvidence(history, evidenceBudget(config, competitors.active), tape.state.leafId);
				},
				write: (work, summary) => {
					// The branch as it reads now decides: a summary of something that changed since is not stored.
					const committed = commitSummary(
						{ work, history: tapeOf(ctx).history(), competing: competitors.active },
						summary,
					);
					if (committed.status === "stored") pi.appendEntry(SUMMARY_KIND, summary);
					return committed;
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
				const tape = tapeOf(ctx);
				if (!tape.history().summary && tape.state.cuts === 0) return;
			}
			historian.start(historianBranch(ctx), generation);
		}

		function signalLine(signal: ReturnType<ContextSignals["snapshot"]>): string {
			const sinceCut =
				signal.requestsSinceCut === undefined
					? "no cut seen yet"
					: `${signal.historyCallsSinceCut} history calls and ${signal.rereadsSinceCut} re-reads of archived files in ${signal.requestsSinceCut} requests since the latest cut`;
			return `Tools this run: ~${signal.runToolTokens.toLocaleString("en-US")} output tokens, ${signal.delegations} delegations; ${sinceCut}`;
		}

		function statusLines(ctx: ExtensionContext): string[] {
			const thresholds = cuts.thresholds(ctx);
			const tape = tapeOf(ctx);
			const { summary } = tape.history();
			const log = tape.archive().entries;
			const tokens = ctx.getContextUsage()?.tokens;
			const summaryItems = summary ? Object.values(summary.sections).reduce((sum, items) => sum + items.length, 0) : 0;
			const notebookBytes = Buffer.byteLength(tape.state.notebook ?? "", "utf8");
			const unavailable = options.summarize ? undefined : historianUnavailable(policy, ctx);
			return [
				`Prompt: ${tokens == null ? "unknown until the next response" : `~${tokens.toLocaleString("en-US")}`} tokens; cut before the next prompt from ${thresholds.soft.toLocaleString("en-US")}, mid-run from ${thresholds.hard.toLocaleString("en-US")}, or on a cold cache above ${config.coldCutMinTokens.toLocaleString("en-US")}`,
				`Cuts on this branch: ${tape.state.cuts}; summary ${summary ? `through #${summary.coveredThroughId}, ${summaryItems} items` : "not started"}; notebook ${notebookBytes} bytes`,
				unavailable !== undefined
					? `Historian unavailable: ${unavailable}.`
					: `Historian: ${historian.stats.runs} runs, ${historian.stats.condensed} condensations, ${historian.stats.failures} failures${historian.stats.lastError ? ` (last: ${historian.stats.lastError})` : ""}${historian.running > 0 ? ", running" : ""}${historian.stats.paused ? `; paused after ${historian.stats.paused.attempts} failed attempts, /context retry-historian tries again` : ""}`,
				signalLine(signals.snapshot()),
				`Cut size: ${lastSizeProblem ?? "no refused or oversized cut in this session"}`,
				`Log: ${log.length.toLocaleString("en-US")} entries, ${log.filter((entry) => entry.status !== "visible").length.toLocaleString("en-US")} archived or edited and searchable`,
				...ledger.report(),
				...reportLines(ctx),
			];
		}

		/**
		 * What the session paid and how it found its history again, from its log: the lines `npm run measure` prints too.
		 * pi loaded the file once; another process on the same session appends requests this one never sees, so the report
		 * reads the file again and adds what this process holds that the file lacks.
		 */
		function reportLines(ctx: ExtensionContext): string[] {
			const entries = mergeEntries([sessionFileEntries(ctx), ctx.sessionManager.getEntries() as unknown as RawEntry[]]);
			const events = retrievalEvents(entries);
			const evidence = config.keptCap.mode === "on" ? capEvidence(ctx) : undefined;
			return [
				...formatCostReport(reduceAccounting(accountingEvents(entries))),
				...formatRetrievalReport(reduceRetrieval(events)),
				...formatCapShadowReport(reduceCapShadow(events)),
				...(config.keptCap.mode === "on"
					? [evidence === undefined ? "Kept cap evidence: the probe record covers this session's model; cuts keep from the capped start" : `Kept cap evidence: none for this session's model, cuts keep the baseline start (${evidence})`]
					: []),
			];
		}

		/** The session file's entries as they are on disk now; none for a session pi keeps in memory or a file not written yet. */
		function sessionFileEntries(ctx: ExtensionContext): readonly RawEntry[] {
			const file = ctx.sessionManager.getSessionFile();
			if (!file) return [];
			if (fileEntries?.file !== file) {
				fileEntries = { file, tail: new SessionFileTail(file, (entry) => (typeof entry.type === "string" ? (entry as RawEntry) : undefined)) };
			}
			return fileEntries.tail.read();
		}

		pi.on("session_start", (_event, ctx) => {
			generation++;
			ledger = new Ledger();
			requests = new RequestTracker();
			historianRequests.reset();
			followed = undefined;
			signals = new ContextSignals();
			const start = tapeOf(ctx);
			const history = start.history();
			if (start.state.cuts > 0) signals.resume(history.entries, history.minKeptIndex, history.visibleFromIndex);
			sizeReported = new Set();
			unavailableReported = new Set();
			competitors = new CompetitorWarnings();
			warnCompetitors(ctx, observeOwners(pi.getCommands(), undefined, undefined));
			lastSizeProblem = undefined;
			cuts.start(ctx);
			sessionId = ctx.sessionManager.getSessionId();
			ledgerFile =
				options.ledgerFile === false
					? undefined
					: (options.ledgerFile ?? join(getAgentDir(), "context", "ledger.jsonl"));
			scheduleHistorian(ctx);
			keepWarm.start(ctx, sessionId);
		});

		function settleRequest(message: Answer, ctx: ExtensionContext): void {
			const { reason, position } = cuts.pending();
			const judged = requests.settle(isRefused(message), reason);
			if (!judged) return;
			const planned = judged.requestClass === "planned";
			const usage = answerUsage(message);
			const signal = signals.request();
			if (planned) signals.cut();
			const prompt = promptTokens(usage);
			// A planned cut stays pending until a request carrying it is accepted; that request reconciles it.
			if (judged.requestClass !== "rejected") cuts.settled(ctx, planned ? prompt : undefined);
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

		// An old session holds keep-warm ping turns (a custom message and its answers): they stay out of the model's view.
		pi.on("context", (event) => {
			const messages = withoutPings(event.messages);
			return messages.length === event.messages.length ? undefined : { messages };
		});

		pi.on("session_shutdown", async (event) => {
			keepWarm.shutdown();
			await historian.shutdown(event.reason);
		});

		pi.on("session_tree", (_event, ctx) => {
			cuts.tree(ctx);
			// The call in flight is for the branch we left; the new branch gets its own.
			void historian.shutdown("branch");
			generation++;
			scheduleHistorian(ctx);
		});

		pi.on("agent_start", () => {
			signals.startRun();
			keepWarm.agentStart();
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
				(path) => tapeOf(ctx).archivedReads().has(path),
			);
			recordNestedRetrieval(event);
			return undefined;
		});

		/**
		 * The transcript keeps the calls the model made and only a bounded record of those made inside another tool, so a
		 * nested search or read is stored here, ids and paths only, and survives a restart.
		 */
		function recordNestedRetrieval(event: { toolCallId: string; parentToolCallId?: string; toolName: string; input: unknown; details?: unknown; isError?: boolean }): void {
			if (!event.parentToolCallId) return;
			const input = (typeof event.input === "object" && event.input !== null ? event.input : {}) as Record<string, unknown>;
			const base = { call: event.toolCallId, parent: event.parentToolCallId, tool: event.toolName };
			if (event.toolName === TOOLS.historySearch.name) {
				const hits = (event.details as { hits?: unknown } | undefined)?.hits;
				pi.appendEntry(RETRIEVAL_KIND, { ...base, ids: Array.isArray(hits) ? hits.filter((id): id is string => typeof id === "string") : [] });
			} else if (event.toolName === TOOLS.historyRead.name && typeof input.id === "string") {
				// The id the archive resolved, not the prefix the model typed: a read counts for the entry it showed.
				const resolved = (event.details as { id?: unknown } | undefined)?.id;
				const id = typeof resolved === "string" ? resolved : input.id.replace(/^#/, "");
				pi.appendEntry(RETRIEVAL_KIND, { ...base, ids: [id], ...(event.isError ? { failed: true } : {}) });
			} else if (event.toolName === "read" && typeof input.path === "string") {
				pi.appendEntry(RETRIEVAL_KIND, { ...base, path: input.path, ...(event.isError ? { failed: true } : {}) });
			}
		}

		// pi's warming decision, and its warms, pass through the keep-warm controller.
		pi.on("cache_warming_decision", (event, ctx) => keepWarm.decide(event.action, ctx));

		// The headers every handler of the request left: the handlers fill this object in place, and the capture of the
		// request keeps what they left, for the ping and the fork to send again.
		pi.on("before_provider_headers", (event) => {
			captures.headersFor(event.headers as Record<string, string | undefined>);
			return undefined;
		});

		pi.on("after_provider_response", (event) => {
			keepWarm.response(event.status);
			return undefined;
		});

		// Cache continuity on the payload the provider receives, judged once the provider answered.
		pi.on("before_provider_request", (event, ctx) => {
			keepWarm.request(event.payload);
			const shape = requestShape(event.payload);
			if (!shape) return undefined;
			requests.begin(shape, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
			if (ctx.model) captures.record(event.payload, ctx.model, now());
			return undefined;
		});

		pi.on("message_end", (event, ctx) => {
			const message = event.message as Answer & { role?: string };
			// A tool result completes the exchange a historian fork continues.
			if (message.role === "toolResult") captures.result(event.message as ToolResultMessage);
			if (message.role !== "assistant") return undefined;
			settleRequest(message, ctx);
			if (message.usage) ledger.addUsage(answerUsage(message));
			if (ctx.model && message.usage && !isRefused(message)) {
				captures.confirm(ctx.model, promptTokens(message.usage), event.message as AssistantMessage);
			}
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

		// The cut owner decides at every boundary; the drafts of handlers that ran before us are passed through.
		pi.on("turn_end", (event, ctx) => {
			// Without a UI the run ends with a turn that calls no tool and the process exits right after, which would
			// cancel a call paid for just now; the next start summarizes the stretch.
			if (ctx.hasUI || event.toolResults.length > 0 || ctx.hasPendingMessages()) scheduleHistorian(ctx);
			if (event.outcome !== "completed" || event.entries.some((entry) => entry.type === "compaction")) return undefined;
			const tokens = ctx.getContextUsage()?.tokens ?? estimateTokens(JSON.stringify(event.context.llmMessages));
			const thresholds = cuts.thresholds(ctx);
			const published: ContextSignalsEvent = { sessionId, contextTokens: tokens, ...thresholds, ...signals.snapshot() };
			pi.events.emit(SIGNALS_CHANNEL, published);
			return cuts.finishTurn(event, ctx, tokens, thresholds);
		});

		pi.on("input", (event, ctx) => cuts.input(event, ctx));

		pi.on("session_before_compact", (event, ctx) => cuts.beforeCompact(event, ctx));

		pi.on("session_compact", (event, ctx) =>
			warnCompetitors(ctx, observeOwners([], cuts.takeProposal(), { ours: decodeContextRecord(event.compactionEntry).kind === "cut" })),
		);

		pi.on("session_compact_failed", () => cuts.compactFailed());

		pi.registerTool({
			...TOOLS.historySearch,
			parameters: historySearchParameters,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const reply = await tapeOf(ctx).archive().search(params, signal);
				return textResult(reply.text, { hits: reply.hits });
			},
		});

		pi.registerTool({
			...TOOLS.historyRead,
			parameters: historyReadParameters,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const read = await tapeOf(ctx).archive().read(params, signal);
				return textResult(read.text, { id: read.id });
			},
		});

		pi.registerTool({
			...TOOLS.notebook,
			parameters: notebookParameters,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (params.text === undefined) return textResult(notebookView(tapeOf(ctx).state.notebook ?? ""), undefined);
				const check = checkNotebook(params.text, config.notebookMaxBytes);
				if (!check.ok) throw new Error(check.message);
				pi.appendEntry(NOTEBOOK_KIND, { text: params.text });
				return textResult(check.message, undefined);
			},
		});

		pi.registerCommand("context", {
			description: "Show context management status: prompt size, cuts, summary and cache continuity; \"retry-historian\" tries a paused summary again",
			handler: async (args, ctx) => {
				if (args.trim() === "retry-historian") {
					const branch = historianBranch(ctx);
					const waiting = historian.retry(branch);
					if (waiting) historian.start(branch, generation);
					ctx.ui.notify(waiting ? "Historian: trying the summary again." : "Historian: no failed summary attempt is waiting.", "info");
					return;
				}
				ctx.ui.notify(statusLines(ctx).join("\n"), "info");
			},
		});
	};
}

export default createContextExtension();

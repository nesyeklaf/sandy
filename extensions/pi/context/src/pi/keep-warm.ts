/**
 * Keep-warm: while a session waits for a prompt it expects after the provider's cache would expire, one side request
 * (a ping) replays the last main request with one output token, so the next prompt reads the cache instead of writing
 * the whole prompt again. The {@link KeepWarm} controller owns when; {@link warmOnce} owns the one request.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { carriedTokens, type ContextConfig } from "../core/config.ts";
import { KEEP_WARM_KIND, WARMING_KIND } from "../core/kinds.ts";
import { readWarmRecord, type WarmRecord, warmWindow } from "../core/warm-record.ts";
import { compareShapes, requestShape } from "../core/continuity.ts";
import { kindOf } from "../core/records.ts";
import { type CacheTier, cacheTtlMs, keepWarmDue, type KeepWarmState, keepWarmPlanned } from "../core/policy.ts";
import type { UsageFigures } from "../core/attempts.ts";
import { type Capture, type CapturePool, FORK_APIS, FORK_HIT_SHARE, isWarming, parseBody, type ProviderSend, REFRESH_LEASE_MS, replayOptions, routeOf } from "./captures.ts";
import { SessionClaim } from "./claim.ts";
import { customRecords, type SessionFileTail } from "./session-attempts.ts";

/**
 * The signal file's name in a SANDY thread's storage. SANDY's workflows write it (sandy/work/workflows/src/keep-warm.ts names
 * the same file), so the two sides must agree on it.
 */
export const KEEP_WARM_FILE = "pi-keep-warm.json";

/**
 * Where a session looks for its keep-warm signal: in the thread's storage when it runs as a Sandy thread
 * (`SANDY_THREAD_STORAGE`, or `BB_THREAD_STORAGE` from before Sandy's rename), else in the agent directory.
 */
export function signalFile(env: Readonly<Record<string, string | undefined>>, agentDir: string, sessionId: string): string {
	const threadStorage = env.SANDY_THREAD_STORAGE || env.BB_THREAD_STORAGE;
	return threadStorage ? join(threadStorage, KEEP_WARM_FILE) : join(agentDir, "context", "keep-warm", `${sessionId}.json`);
}

/** Cache read and write cost relative to fresh input, when a model's catalogue carries no prices. */
const FALLBACK_COSTS = { read: 0.1, write: 1.25 } as const;

interface PricedModel {
	readonly provider: string;
	readonly cost?: { readonly input: number; readonly cacheRead: number; readonly cacheWrite: number };
}

/**
 * Price per token of a cache read and of writing the prompt again. A provider without a write premium writes at the
 * input price; Anthropic's long tier writes at twice the input price, which its catalogue entry does not carry.
 */
export function cacheCosts(model: PricedModel | undefined, tier: CacheTier): { read: number; write: number } {
	const cost = model?.cost;
	if (!cost || cost.input <= 0 || cost.cacheRead <= 0) return FALLBACK_COSTS;
	if (model.provider === "anthropic" && tier === "long") return { read: cost.cacheRead, write: 2 * cost.input };
	return { read: cost.cacheRead, write: cost.cacheWrite > 0 ? cost.cacheWrite : cost.input };
}

/** Until when the signal file says the session expects another prompt, in epoch ms; undefined without a valid file. */
export function readKeepWarmSignal(file: string): number | undefined {
	if (!existsSync(file)) return undefined;
	try {
		const until = (JSON.parse(readFileSync(file, "utf8")) as { until?: unknown }).until;
		return typeof until === "number" && Number.isFinite(until) ? until : undefined;
	} catch {
		return undefined;
	}
}


/** Why a capture is not replayed as a one-token request. */
export type ReplayRefusal = "thinking-budget" | "server-side" | "api" | "unanswered";

/**
 * Why the last main request cannot be replayed with one output token, or undefined when it can. Anthropic derives a
 * fixed thinking budget from the output limit, so one token would change the request: pi's own warmer handles those,
 * and so does it for an API this module does not know. A request that hands the provider work to run is not sent twice,
 * and one the provider never answered holds no cache to refresh. (pi's own rule is not exported; this is its port.)
 */
export function replayRefusal(capture: Capture): ReplayRefusal | undefined {
	if (capture.thinkingBudget !== undefined) return "thinking-budget";
	if (capture.serverSide) return "server-side";
	if (!FORK_APIS.has(capture.api)) return "api";
	if (capture.promptTokens === undefined) return "unanswered";
	return undefined;
}

export const isReplayable = (capture: Capture): boolean => replayRefusal(capture) === undefined;

interface ContextMessage {
	readonly role: string;
	readonly customType?: string;
}

/**
 * The messages without answered legacy pings. A legacy ping is a custom message of the keep-warm kind followed by the
 * assistant and tool result messages that answered it; it read the prefix before it, so that prefix is what the cache
 * holds, and once a later message follows the ping leaves the model's view. A ping with nothing after it stays. The one
 * place that decides it: the context hook strips the outgoing request with it and SessionTape reads the model view with
 * it. `messageOf` reads the message out of an item that carries one.
 */
export function withoutPings<T>(
	items: readonly T[],
	messageOf: (item: T) => ContextMessage | undefined = (item) => item as ContextMessage,
): T[] {
	const role = (index: number) => messageOf(items[index] as T)?.role;
	const kept: T[] = [];
	for (let index = 0; index < items.length; index++) {
		if (role(index) !== "custom" || kindOf(messageOf(items[index] as T)?.customType) !== "keep-warm") {
			kept.push(items[index] as T);
			continue;
		}
		let end = index + 1;
		while (end < items.length && ["assistant", "toolResult"].includes(role(end) ?? "")) end++;
		if (end === items.length) return [...kept, ...items.slice(index)];
		index = end - 1;
	}
	return kept;
}

/** What the keep-warm request needs from the session. */
export interface WarmHost {
	readonly send: ProviderSend;
	/** The session's model: it must be the route the capture went. */
	readonly model: Model<Api>;
	readonly sessionId?: string;
	readonly fetch?: typeof fetch;
	/** Stores the record of the request right before its one HTTP request leaves; a throw declines the request. */
	readonly sending: () => void;
}

export type WarmResult =
	/** The provider read the cached prompt: the cache lives on, from this request's start. */
	| { readonly status: "warmed"; readonly usage: UsageFigures; readonly cacheRead: number }
	/** The provider answered but read less than the prompt held: the cache had expired, and this request rewrote it. */
	| { readonly status: "missed"; readonly usage: UsageFigures; readonly cacheRead: number }
	/** Nothing was sent. */
	| { readonly status: "refused"; readonly why: ReplayRefusal | "route" | "head" | "prefix" | "output-limit" | "unreadable" | "unrecorded" }
	/** A request left and got no usable answer; `usage` is what the provider reported, if anything. */
	| { readonly status: "failed"; readonly usage?: UsageFigures };

function usageOf(message: AssistantMessage): UsageFigures {
	const { input, output, cacheRead, cacheWrite, cost } = message.usage;
	return { input, output, cacheRead, cacheWrite, cost: cost.total };
}

/**
 * Replays the last main request with one output token, outside the agent loop: no session message, no tool, no turn.
 * The request goes through pi-ai like every other (`host.send`), with the payload hook putting the captured request
 * in place of what pi-ai built and the headers the main request left with (see {@link replayOptions}), and the fetch
 * pi-ai hands the body to checks the bytes about to leave: the captured head and every captured message unchanged, one
 * output token. A refusal declines before anything is sent. No retries: a
 * second fetch fails the request. Whether the cache answered is judged from its usage: less than {@link FORK_HIT_SHARE}
 * of the prompt read means it had expired.
 */
export async function warmOnce(capture: Capture, signal: AbortSignal, host: WarmHost): Promise<WarmResult> {
	const why = replayRefusal(capture);
	if (why) return { status: "refused", why };
	if (capture.route !== routeOf(host.model)) return { status: "refused", why: "route" };
	const captured = JSON.parse(capture.json) as Record<string, unknown>;
	let declined: Extract<WarmResult, { status: "refused" }>["why"] | undefined;
	let unrecorded: unknown;
	let sends = 0;
	const guard: typeof fetch = async (input, init) => {
		if (sends > 0) throw new Error("keep-warm: refused to resend");
		const body = parseBody(init?.body);
		// The SDK moves `betas` from the payload into a header; the body is compared with the capture without them.
		const outgoing = body && ("betas" in body || !("betas" in captured) ? body : { ...body, betas: captured.betas });
		const shape = outgoing && requestShape(outgoing);
		if (!outgoing || !shape) declined = "unreadable";
		else if (outgoing.max_tokens !== 1) declined = "output-limit";
		else if (shape.head !== capture.shape.head) declined = "head";
		else if (shape.items.length !== capture.shape.items.length || compareShapes(capture.shape, shape).kind !== "continued") declined = "prefix";
		if (declined) throw new Error("keep-warm: refused to send (" + declined + ")");
		try {
			host.sending();
		} catch (error) {
			unrecorded = error;
			throw error;
		}
		sends++;
		return (host.fetch ?? globalThis.fetch)(input, init);
	};
	let response: AssistantMessage;
	try {
		response = await host.send(
			host.model,
			{ messages: [{ role: "user", content: "ping", timestamp: 0 }] },
			{
				signal,
				maxRetries: 0,
				transport: "sse",
				fetch: guard,
				...replayOptions(capture),
				...(host.sessionId ? { sessionId: host.sessionId } : {}),
				onPayload: () => ({ ...captured, max_tokens: 1 }),
			},
		);
	} catch {
		return sends === 0 ? { status: "refused", why: declined ?? (unrecorded ? "unrecorded" : "unreadable") } : { status: "failed" };
	}
	if (sends === 0) return { status: "refused", why: declined ?? (unrecorded ? "unrecorded" : "unreadable") };
	const usage = usageOf(response);
	// One token ends the answer at the limit (`length`); anything else that is not a normal end is an error.
	if (response.stopReason === "error" || response.stopReason === "aborted") return { status: "failed", ...(usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 ? { usage } : {}) };
	const cacheRead = response.usage.cacheRead;
	return { status: cacheRead < (capture.promptTokens ?? 0) * FORK_HIT_SHARE ? "missed" : "warmed", usage, cacheRead };
}

/** What the keep-warm controller needs from the extension. */
export interface KeepWarmDeps {
	readonly config: ContextConfig;
	readonly pi: ExtensionAPI;
	/** The main requests the ping replays; their cache clock is the historian's fork's too. */
	readonly captures: CapturePool;
	readonly now: () => number;
	/** The signal file and the tick; false turns pings off. */
	readonly settings: { readonly file?: string; readonly intervalMs?: number } | false | undefined;
	readonly tier: () => CacheTier;
	/** The prompt size from which a cut is planned before the next prompt: a larger context is cut, not kept warm. */
	readonly softTokens: (ctx: ExtensionContext) => number;
}

/** The ping this process would send for the waiting session, with what decides when. */
interface PingPlan {
	readonly capture: Capture;
	readonly model: Model<Api>;
	readonly state: KeepWarmState;
}

/**
 * The one owner of keep-warm in a session: the timer, the decision whether a ping runs for the window the session is
 * in, the ping itself and its records, and pi's own warmer, whose decision this engine stops while a ping of its own will
 * run, so the window is paid once. The cache clock is the capture's ({@link CapturePool.touch}), shared with the
 * historian's fork, and so is the admission of a refresh ({@link CapturePool.admit}): while the fork or pi's warmer
 * reads the prefix no ping starts, and while a ping reads it the fork waits.
 */
export class KeepWarm {
	readonly #deps: KeepWarmDeps;
	#timer: ReturnType<typeof setInterval> | undefined;
	/** The newest context, for the timer. */
	#context: ExtensionContext | undefined;
	#sessionId = "";
	/** The signal file the session says its next prompt in; undefined when keep-warm is off. */
	#file: string | undefined;
	/** The ping in flight, so a tick never starts a second and shutdown can cancel it. */
	#warming: AbortController | undefined;
	/** Whether the ping stands down for good: the cache did not answer one. */
	#stopped = false;
	/** The cache start a refused or failed ping was tried for: the same cache is not tried twice. */
	#triedFor: number | undefined;
	/** pi's own warmer has a request out: when it started, and the end of its mark on the refresh in flight. */
	#native: { readonly at: number; readonly end: () => void } | undefined;
	readonly #claim = new SessionClaim("keep-warm");
	/** The keep-warm records of the session file, as every process on it wrote them. */
	#records: { readonly file: string; readonly tail: SessionFileTail<WarmRecord> } | undefined;
	/** A stop decision whose warm has not left; a warm leaving now was sent by a later handler's override. */
	#stopPending: "warm" | "stop" | undefined;
	/** Whether this process saw a request pass `before_provider_request`, so it would see a warm replaying one. */
	#requestsSeen = false;

	constructor(deps: KeepWarmDeps) {
		this.#deps = deps;
	}

	/** A new session: nothing of the last one's pings carries over, and the timer starts for this one. */
	start(ctx: ExtensionContext, sessionId: string): void {
		this.#warming?.abort();
		this.#native?.end();
		this.#native = undefined;
		this.#stopped = false;
		this.#triedFor = undefined;
		this.#stopPending = undefined;
		this.#context = ctx;
		this.#sessionId = sessionId;
		clearInterval(this.#timer);
		this.#file = undefined;
		const settings = this.#deps.settings;
		if (settings === false) return;
		this.#file = settings?.file ?? signalFile(process.env, getAgentDir(), sessionId);
		this.#timer = setInterval(() => {
			this.tick().catch(() => {
				// The session was replaced or disposed without a shutdown event; its context is stale.
				clearInterval(this.#timer);
				this.#context = undefined;
			});
		}, settings?.intervalMs ?? 30_000);
		// A waiting session must not keep a finished process (pi -p) alive.
		this.#timer.unref?.();
	}

	shutdown(): void {
		clearInterval(this.#timer);
		this.#warming?.abort();
		this.#claim.release();
		this.#context = undefined;
	}

	/**
	 * pi's warming handlers share one event and the last action wins, so nothing afterwards says what was decided. Each
	 * decision is stored before a warm can leave; the cost report reads a stop as a skipped request only if the log shows
	 * nothing overrode it. pi's decision changes only to stop it while a ping of our own will run for the window.
	 */
	decide(piAction: "warm" | "stop", ctx: ExtensionContext): { action: "stop" } | undefined {
		const ours = this.#plan(ctx) !== undefined;
		const action = ours ? "stop" : piAction;
		this.#deps.pi.appendEntry(WARMING_KIND, { piAction, action, requestsSeen: this.#requestsSeen });
		this.#stopPending = action === "stop" ? piAction : undefined;
		return ours ? { action: "stop" } : undefined;
	}

	agentStart(): void {
		this.#stopPending = undefined;
	}

	/** A provider request passes `before_provider_request`: pi's own warmer replays through it too. */
	request(payload: unknown): void {
		this.#requestsSeen = true;
		if (!isWarming(payload)) return;
		if (this.#stopPending) {
			// A warm leaving after a stop: a handler after this one overrode it, and the warm is paid.
			this.#deps.pi.appendEntry(WARMING_KIND, { piAction: this.#stopPending, action: "warm", requestsSeen: true, sent: true });
			this.#stopPending = undefined;
		}
		this.#native?.end();
		this.#native = { at: this.#deps.now(), end: this.#deps.captures.refresh("native", REFRESH_LEASE_MS) };
	}

	/** The provider answered a request; an answered warm of pi's own read the prefix, which lives on from its start. */
	response(status: number): void {
		const native = this.#native;
		if (!native) return;
		this.#native = undefined;
		native.end();
		const capture = this.#deps.captures.latest();
		if (capture && status >= 200 && status < 300) this.#deps.captures.touch(capture, native.at);
	}

	/**
	 * The ping that will run for the window the session is in, or undefined when none will: the one owner of that
	 * question, asked by the timer tick and by pi's warming decision alike. A ping runs only while the session is idle,
	 * has a signal that is not expired, a main request it can replay unchanged on this route, a window it has not
	 * tried and a plan that pays (`keepWarmPlanned`). Until then pi's warmer keeps its own decision.
	 */
	#plan(ctx: ExtensionContext): PingPlan | undefined {
		const model = ctx.model;
		if (this.#stopped || !this.#file || !model) return undefined;
		const { captures, config, tier } = this.#deps;
		const capture = captures.latest();
		if (!capture || !isReplayable(capture) || capture.route !== routeOf(model)) return undefined;
		// A later handler that changed pi's payload in place changed what was cached: the capture is not it.
		if (!captures.unchanged(capture)) return undefined;
		if (this.#triedFor === capture.touchedAt) return undefined;
		// While the agent streams, pi's warmer is the only one that keeps the cache alive across a long tool call.
		if (!this.#warming && !ctx.isIdle()) return undefined;
		const costs = cacheCosts(model, tier());
		const state: KeepWarmState = {
			cacheStart: capture.touchedAt,
			ttlMs: cacheTtlMs(config, model, tier()),
			until: readKeepWarmSignal(this.#file),
			contextTokens: ctx.getContextUsage()?.tokens ?? undefined,
			softTokens: this.#deps.softTokens(ctx),
			minTokens: config.coldCutMinTokens,
			carriedTokens: carriedTokens(config),
			cacheReadCost: costs.read,
			cacheWriteCost: costs.write,
		};
		return keepWarmPlanned(state, this.#deps.now()) ? { capture, model, state } : undefined;
	}

	/** The keep-warm records every process appended to the session file, read from where the last read stopped. */
	#warmRecords(file: string): readonly WarmRecord[] {
		if (this.#records?.file !== file) this.#records = { file, tail: customRecords(file, KEEP_WARM_KIND, readWarmRecord) };
		return this.#records.tail.read();
	}

	/** One timer tick: ping when a prompt is expected after the cache expires and keeping it warm is cheaper. */
	async tick(): Promise<void> {
		const ctx = this.#context;
		const { captures, now, pi } = this.#deps;
		if (!ctx || this.#warming) return;
		const first = this.#plan(ctx);
		if (!first || !keepWarmDue(first.state, now())) return;
		// One refresh of the prefix at a time: the fork or pi's warmer reading it renews the cache this ping would.
		const ending = captures.admit("warm", REFRESH_LEASE_MS);
		if (!ending) return;
		const file = ctx.sessionManager.getSessionFile();
		// One ping per session and window across processes: whoever holds the claim sends, the others find its records.
		const claim = this.#claim.claimFor(file);
		if (claim && !claim.acquire()) {
			ending();
			return;
		}
		const controller = new AbortController();
		this.#warming = controller;
		try {
			if (file !== undefined) {
				const seen = warmWindow(this.#warmRecords(file), first.capture.touchedAt);
				if (seen.warmedAt !== undefined) captures.touch(first.capture, seen.warmedAt);
				if (seen.missed) this.#stopped = true;
				// A request another process left without an end may have been paid for: it is not sent again.
				else if (seen.tried) this.#triedFor = first.capture.touchedAt;
			}
			const plan = this.#plan(ctx);
			const at = now();
			if (!plan || !keepWarmDue(plan.state, at)) return;
			const { capture, model } = plan;
			const cacheStart = capture.touchedAt;
			const id = randomUUID();
			const result = await warmOnce(capture, controller.signal, {
				send: (sent, context, requestOptions) => ctx.modelRegistry.streamSimple(sent, context, requestOptions).result(),
				model,
				sessionId: this.#sessionId,
				sending: () => pi.appendEntry(KEEP_WARM_KIND, { type: "start", id, at, model: `${model.provider}/${model.id}` }),
			});
			if (result.status === "warmed" || result.status === "missed") {
				// A miss wrote the prefix again: the cache lives on from this request either way, though pings stop.
				captures.touch(capture, at);
				if (result.status === "missed") this.#stopped = true;
				pi.appendEntry(KEEP_WARM_KIND, { type: "end", id, at, outcome: result.status, usage: result.usage });
			} else {
				this.#triedFor = cacheStart;
				if (result.status === "failed") {
					pi.appendEntry(KEEP_WARM_KIND, { type: "end", id, at, outcome: controller.signal.aborted ? "aborted" : "failed", ...(result.usage ? { usage: result.usage } : {}) });
				}
			}
		} finally {
			ending();
			if (this.#warming === controller) this.#warming = undefined;
			claim?.release();
		}
	}
}

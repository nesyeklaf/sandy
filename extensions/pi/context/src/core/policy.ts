import { type CacheTtl, type ContextConfig, carriedTokens } from "./config.ts";
import { PROVIDER_TOKENS_PER_ESTIMATE } from "./tokens.ts";

/** Why a cut happened. Every cut is a planned cache break. */
export type CutReason = "watermark" | "cold" | "model" | "task" | "threshold" | "overflow" | "manual";

/**
 * Room Pi keeps free for the answer: it compacts on its own above `contextWindow - PI_RESERVE`. The watermark stays
 * one reserve below that.
 */
export const PI_RESERVE = 16_384;

/**
 * Where cuts happen. At `soft` an interactive session cuts before its next prompt, where the finished turn is condensed
 * in the answer and the cache is often cold anyway; a session without a user cuts at the next turn boundary. At `hard`
 * every session cuts at the next turn boundary, also in the middle of a run. On windows too small for the deferral
 * margin both are the same.
 */
export interface CutThresholds {
	readonly soft: number;
	readonly hard: number;
}

/** `reserve` is the room pi keeps for the answer in this session; see {@link CutEnvelope}. */
export function cutThresholds(
	config: ContextConfig,
	contextWindow: number | undefined,
	reserve: number = PI_RESERVE,
): CutThresholds {
	const window = contextWindow !== undefined && contextWindow > 0 ? contextWindow : Number.POSITIVE_INFINITY;
	const hard = Math.max(
		1,
		Math.min(config.watermarkTokens + config.deferMarginTokens, config.hardCapTokens, window - 2 * reserve),
	);
	return { soft: Math.min(config.watermarkTokens, hard), hard };
}

/** The soft threshold; kept for callers that only need the planned cut point. */
export function effectiveWatermark(config: ContextConfig, contextWindow: number | undefined): number {
	return cutThresholds(config, contextWindow).soft;
}

/**
 * Whether cuts can work below `watermark`: what a cut leaves in the context must stay below it, otherwise every cut is
 * followed by another. A window too small for the config gets no cuts.
 */
export function watermarkHolds(config: ContextConfig, watermark: number): boolean {
	return carriedTokens(config) < watermark;
}

export interface CutSize {
	/** The prompt as the provider counted it. */
	readonly contextTokens: number;
	/** Estimated tokens of what the prompt holds from the log: the visible entries and the latest cut's block. */
	readonly visibleTokens: number;
	/** Estimated tokens of the history the cut archives. */
	readonly archivedTokens: number;
	/** Estimated tokens of the cut's block. */
	readonly blockTokens: number;
	readonly limit: number;
}

/**
 * The prompt after a cut, in the provider's tokens: the prompt loses the history the cut archives and gains its block.
 *
 * The estimates count four characters per token, the provider counts with its tokenizer, in session 01a171b8 about
 * 1.8 times as many for code, JSON and German text. The estimated change is therefore scaled by the ratio of the
 * prompt to its estimate. The system prompt and tools are in the prompt but not in the estimate, which raises the
 * ratio; archived history, rich in tool output, counts more tokens per character than what stays, which the raised
 * ratio happens to balance. Checked against 54 cuts of October 2026: the projection missed the next prompt by -0.2k on
 * average (RMS 16k); taking the system prompt out of the ratio biased it by +9k to +15k.
 */
export function projectedTokens(size: Omit<CutSize, "limit">): number {
	const { contextTokens, visibleTokens, archivedTokens, blockTokens } = size;
	const ratio = visibleTokens > 0 ? contextTokens / visibleTokens : 1;
	return contextTokens - (archivedTokens - blockTokens) * ratio;
}

/**
 * Whether a cut brings the prompt below `limit`. A cut that does not would be followed by another at the next chance.
 */
export function cutShrinks(size: CutSize): boolean {
	return projectedTokens(size) < size.limit;
}

/**
 * Share of the prompt a cut must free at or past the hard threshold when it cannot reach its limit. A cut right after
 * such a cut archives little and frees less, so the cuts that stay above the limit still do not follow each other.
 */
export const HARD_CUT_MIN_SHARE = 0.25;

/**
 * Whether to make a cut: when it brings the prompt below `limit`, or, once the prompt has reached `hard`, when it
 * frees at least {@link HARD_CUT_MIN_SHARE} of it. Refusing that cut would let the prompt grow until pi compacts on its
 * own near the model window, on a window of 1M tokens at over 900k.
 */
export function cutAccepted(size: CutSize, hard: number): boolean {
	return cutFrees(projectedTokens(size), size.contextTokens, size.limit, hard);
}

/** {@link cutAccepted} for a cut expected to leave `expected` tokens of a prompt of `contextTokens`. */
export function cutFrees(expected: number, contextTokens: number, limit: number, hard: number): boolean {
	if (expected < limit) return true;
	return contextTokens >= hard && contextTokens - expected >= contextTokens * HARD_CUT_MIN_SHARE;
}

/**
 * What every request after a cut carries besides the log, and the room pi keeps free. All of it is estimated from
 * text, four characters per token scaled by {@link PROVIDER_TOKENS_PER_ESTIMATE}: the provider's tokenizer counts
 * differently, so the next request reconciles the expectation instead of trusting it.
 */
export interface CutEnvelope {
	/** Estimated provider tokens of the system prompt and the active tools' declarations. */
	readonly fixedTokens: number;
	/** The room pi keeps for the answer: it compacts on its own above `contextWindow - reserveTokens`. */
	readonly reserveTokens: number;
	readonly contextWindow: number | undefined;
}

/** Where pi's own compaction starts: what a cut must leave the prompt below to free any headroom. */
export function nativeLimit(envelope: CutEnvelope): number {
	const window = envelope.contextWindow;
	return window !== undefined && window > 0 ? window - envelope.reserveTokens : Number.POSITIVE_INFINITY;
}

/** The estimated log part of a cut's result: its block and the history it keeps. */
export interface CutRemainder {
	/** The prompt before the cut as the provider counted it; undefined when no count is known. */
	readonly contextTokens: number | undefined;
	readonly visibleTokens: number;
	readonly archivedTokens: number;
	readonly blockTokens: number;
	/** Estimated tokens of the history the cut keeps verbatim: the legal suffix that cannot be cut. */
	readonly keptTokens: number;
}

/**
 * The prompt a cut is expected to leave, an estimate. With a provider count it is {@link projectedTokens}, which was
 * measured unbiased; it is never taken below the floor of what the next request certainly carries again: the system
 * prompt and tools plus the block and the kept history at one provider token per estimated token. Without a count the
 * estimate is scaled by {@link PROVIDER_TOKENS_PER_ESTIMATE}. A large system prompt inflates the projection's ratio,
 * which the floor catches.
 */
export function expectedTokens(remainder: CutRemainder, envelope: CutEnvelope): number {
	const carried = remainder.blockTokens + remainder.keptTokens;
	const floor = envelope.fixedTokens + carried;
	if (remainder.contextTokens === undefined) return envelope.fixedTokens + carried * PROVIDER_TOKENS_PER_ESTIMATE;
	return Math.max(floor, projectedTokens({ ...remainder, contextTokens: remainder.contextTokens }));
}

/**
 * Whether cuts can work below `watermark` in this envelope: what a cut carries plus the system prompt and tools must
 * stay below it, otherwise every watermark cut is refused or followed by another.
 */
export function envelopeHolds(config: ContextConfig, envelope: CutEnvelope, watermark: number): boolean {
	return envelope.fixedTokens + carriedTokens(config) < Math.min(watermark, nativeLimit(envelope));
}

/**
 * At a turn boundary, cut once the prompt has reached `hard`, or `soft` when no user prompt will come to cut at:
 * a session without a user, or a run whose next prompt is already queued.
 */
export function boundaryCut(
	contextTokens: number | undefined,
	thresholds: CutThresholds,
	deferToPrompt: boolean,
): boolean {
	if (contextTokens === undefined) return false;
	return contextTokens >= (deferToPrompt ? thresholds.hard : thresholds.soft);
}

export interface ReminderObservation {
	readonly contextTokens: number | undefined;
	readonly watermark: number;
	/** Fraction of the watermark from which on a reminder is due. */
	readonly at: number;
	/** The notebook was written since the last cut, or since the start when there was none. */
	readonly notebookCurrent: boolean;
	/** A reminder was already appended since the last cut. */
	readonly reminded: boolean;
}

/**
 * At a turn boundary that is not a cut, remind the agent once per cut to update its notebook
 * while it still has the history the next cut will archive.
 */
export function notebookReminderDue(observation: ReminderObservation): boolean {
	const { contextTokens, watermark } = observation;
	if (contextTokens === undefined || observation.notebookCurrent || observation.reminded) return false;
	return contextTokens >= watermark * observation.at;
}

/** How long a provider keeps a prompt cache: the short tier unless the requests ask for the long one. */
export type CacheTier = "short" | "long";

/** A cache's lifetime in seconds when the long tier is asked for and the model declares none. */
const LONG_CACHE_SECONDS = 3_600;

/** The model a cache lifetime is looked up for. */
export interface CacheModel {
	readonly provider: string;
	readonly id: string;
	/** What the model declares, in seconds per tier. */
	readonly promptCache?: CacheTtl;
}

/**
 * A model's prompt cache lifetime in milliseconds for the tier. The first source that names the tier wins: the
 * measured `cacheTtlSeconds` for `provider/model`, then for `provider`, then what the model declares, else an hour
 * for the long tier and `fallbackCacheTtlSeconds` for the short one.
 */
export function cacheTtlMs(config: ContextConfig, model: CacheModel | undefined, tier: CacheTier): number {
	const table = config.cacheTtlSeconds;
	const seconds =
		(model &&
			(table[`${model.provider}/${model.id}`]?.[tier] ?? table[model.provider]?.[tier] ?? model.promptCache?.[tier])) ??
		(tier === "long" ? LONG_CACHE_SECONDS : config.fallbackCacheTtlSeconds);
	return seconds * 1_000;
}

/** How long before its cache expires a waiting session gets its keep-warm ping: one timer tick and a slow request fit in it. */
export const KEEP_WARM_LEAD_MS = 60_000;

/** What decides a keep-warm ping: the cache, the expected prompt and the prices. */
export interface KeepWarmState {
	/**
	 * Request start, epoch ms, of the last request that wrote or read the cache: the provider counts the cache's
	 * lifetime from there, not from the answer's end. Undefined without a request to count from.
	 */
	readonly cacheStart: number | undefined;
	readonly ttlMs: number;
	/** Until when the session expects another prompt, from its keep-warm signal; undefined without one. */
	readonly until: number | undefined;
	readonly contextTokens: number | undefined;
	/** From here the next prompt cuts first and a warm cache would be thrown away, as in {@link promptCut}. */
	readonly softTokens: number;
	/** Above this a cold resume cuts first and writes only `carriedTokens`, as in {@link promptCut}. */
	readonly minTokens: number;
	readonly carriedTokens: number;
	/** Price per token of a cache read and a cache write, in any one unit. */
	readonly cacheReadCost: number;
	readonly cacheWriteCost: number;
}

/**
 * Whether a ping is in the plan for this cache window at `now`, early or late: the cache is still warm and expires
 * before the session's next prompt, the next prompt would not cut anyway, and the pings until that prompt, plus the
 * prompt reading the cache, cost less than letting it go cold and writing the cut context again. While this holds the
 * ping owns the window and pi's own warmer stands down; {@link keepWarmDue} says when the ping leaves.
 */
export function keepWarmPlanned(state: KeepWarmState, now: number): boolean {
	const { cacheStart, ttlMs, until, contextTokens } = state;
	if (cacheStart === undefined || until === undefined || contextTokens === undefined) return false;
	if (contextTokens >= state.softTokens) return false;
	const expires = cacheStart + ttlMs;
	if (now >= expires || until <= expires) return false;
	const beyond = until - now - ttlMs;
	const pings = beyond <= 0 ? 1 : 1 + Math.ceil(beyond / Math.max(ttlMs - KEEP_WARM_LEAD_MS, KEEP_WARM_LEAD_MS));
	const warm = (pings + 1) * state.cacheReadCost * contextTokens;
	const resumed = contextTokens >= state.minTokens ? state.carriedTokens : contextTokens;
	return warm < state.cacheWriteCost * resumed;
}

/** Ping a session at `now`: planned (see {@link keepWarmPlanned}) and the cache expires within {@link KEEP_WARM_LEAD_MS}. */
export function keepWarmDue(state: KeepWarmState, now: number): boolean {
	return state.cacheStart !== undefined && now >= state.cacheStart + state.ttlMs - KEEP_WARM_LEAD_MS && keepWarmPlanned(state, now);
}

export interface PromptObservation {
	readonly contextTokens: number | undefined;
	readonly now: number;
	/** Last moment the provider cache was written or read: the last response or cache refresh. */
	readonly lastCacheTouch: number | undefined;
	readonly ttlMs: number;
	readonly modelKey: string | undefined;
	readonly lastModelKey: string | undefined;
	readonly minTokens: number;
	/** The soft threshold: at or above it the deferred watermark cut happens now. */
	readonly soft: number;
}

/**
 * Before a new prompt, cut when the cache is lost anyway: the model changed or the cache
 * outlived its lifetime. Small prompts are left alone because a cut would barely shrink them.
 * At the soft threshold the deferred watermark cut happens here.
 */
export function promptCut(observation: PromptObservation): "watermark" | "cold" | "model" | undefined {
	const { contextTokens, minTokens } = observation;
	if (contextTokens === undefined) return undefined;
	if (contextTokens >= observation.soft) return "watermark";
	if (contextTokens < minTokens) return undefined;
	if (observation.modelKey && observation.lastModelKey && observation.modelKey !== observation.lastModelKey) {
		return "model";
	}
	if (observation.lastCacheTouch !== undefined && observation.now - observation.lastCacheTouch > observation.ttlMs) {
		return "cold";
	}
	return undefined;
}

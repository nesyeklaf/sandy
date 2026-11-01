import { SKILLS_SECTION_TOKENS } from "./skills.ts";
import { PROVIDER_TOKENS_PER_ESTIMATE } from "./tokens.ts";

export interface HistorianConfig {
	readonly enabled: boolean;
	/** `provider/model` used for summaries. Defaults to the session's current model. */
	readonly model?: string;
	/**
	 * `provider/model` asked when the first model fails, for example a session model that cannot turn thinking off and
	 * spends the output limit on it. No fallback when unset.
	 */
	readonly fallbackModel?: string;
	/** Start summarizing once the prompt reaches this many tokens; below it a session may never be cut. */
	readonly startTokens: number;
	/** Start a summary once this much archivable history is unsummarized. */
	readonly chunkMinTokens: number;
	/** Largest stretch summarized in one call. */
	readonly chunkMaxTokens: number;
	readonly maxOutputTokens: number;
}

/** A prompt cache lifetime in seconds per tier; a missing tier falls through to the next source. */
export interface CacheTtl {
	readonly short?: number;
	readonly long?: number;
}

export interface ContextConfig {
	/** Cut when the prompt reaches this many tokens. This is the planned cache break. */
	readonly watermarkTokens: number;
	/** Ceiling for the prompt whatever the model window allows. */
	readonly hardCapTokens: number;
	/**
	 * How far past the watermark an interactive session may grow while its cut waits for the next prompt. Beyond it the
	 * cut happens at the next turn boundary, in the middle of a run if need be.
	 */
	readonly deferMarginTokens: number;
	/**
	 * Recent history kept verbatim after a cut. This and the other budgets are in the provider's tokens, like the
	 * watermark; the cut converts them to estimated tokens with {@link PROVIDER_TOKENS_PER_ESTIMATE}.
	 */
	readonly keepRecentTokens: number;
	/** Budget for older turns rendered with tool output replaced by references. */
	readonly maskedTokens: number;
	/** Budget for earlier user messages carried verbatim. */
	readonly pinnedUserTokens: number;
	/** Budget for the anchored summary. */
	readonly summaryTokens: number;
	/** Files listed per category (modified, read). */
	readonly filesListed: number;
	/** A cold cache or a model change is used for a cut only above this prompt size. */
	readonly coldCutMinTokens: number;
	/**
	 * A finished task is used for a cut only above this prompt size. The cut breaks a warm cache, so it pays only close
	 * enough to the watermark, where a cut would come soon anyway.
	 */
	readonly taskCutMinTokens: number;
	readonly notebookMaxBytes: number;
	/**
	 * Fraction of the watermark at which the agent is reminded, once per cut, to update a notebook
	 * it has not written since the last cut. The reminder is appended, so the cache prefix holds.
	 */
	readonly notebookReminderAt: number;
	/** Prompt cache lifetime when the model declares none. */
	readonly fallbackCacheTtlSeconds: number;
	/**
	 * Measured prompt cache lifetimes, keyed by `provider/model` or by `provider`. They win over what a model
	 * declares, because a provider may keep a cache shorter or longer than its catalogue says.
	 */
	readonly cacheTtlSeconds: Readonly<Record<string, CacheTtl>>;
	readonly historian: HistorianConfig;
}

export const DEFAULT_CONFIG: ContextConfig = {
	watermarkTokens: 120_000,
	hardCapTokens: 200_000,
	deferMarginTokens: 30_000,
	keepRecentTokens: 16_000,
	maskedTokens: 6_000,
	pinnedUserTokens: 4_000,
	summaryTokens: 8_000,
	filesListed: 25,
	coldCutMinTokens: 60_000,
	taskCutMinTokens: 80_000,
	notebookMaxBytes: 8_192,
	notebookReminderAt: 0.8,
	fallbackCacheTtlSeconds: 300,
	cacheTtlSeconds: {
		// The ChatGPT subscription backend keeps a Codex cache without expiry, so a waiting session is never pinged and
		// never cut for a cold cache. Cuts happen at the watermark and on a model change.
		"openai-codex": { short: Number.POSITIVE_INFINITY, long: Number.POSITIVE_INFINITY },
		// Anthropic documents 5 minutes, or 1 hour when the request asks for it; measured to hold 20 minutes.
		anthropic: { short: 300, long: 3_600 },
	},
	historian: {
		enabled: true,
		startTokens: 60_000,
		chunkMinTokens: 12_000,
		chunkMaxTokens: 40_000,
		maxOutputTokens: 4_096,
	},
};

export type ContextConfigInput = Partial<Omit<ContextConfig, "historian" | "cacheTtlSeconds">> & {
	/** Merged per key over the defaults. */
	readonly cacheTtlSeconds?: Readonly<Record<string, CacheTtl>>;
	readonly historian?: Partial<HistorianConfig>;
};

/**
 * What a cut leaves in the context at most, in the provider's tokens: the kept history and the budgets the cut
 * carries, the skills section and the notebook included. The system prompt and tools come on top; they are not known
 * before the first request, so a watermark that holds this can still be missed, which the extension reports when a
 * cut leaves the prompt above it.
 */
export function carriedTokens(config: ContextConfig): number {
	const estimated = SKILLS_SECTION_TOKENS + Math.ceil(config.notebookMaxBytes / 4);
	return (
		config.keepRecentTokens +
		config.maskedTokens +
		config.pinnedUserTokens +
		config.summaryTokens +
		Math.ceil(estimated * PROVIDER_TOKENS_PER_ESTIMATE)
	);
}

/** Merge inputs left to right over the defaults and reject settings that cannot work. */
export function resolveConfig(...inputs: readonly (ContextConfigInput | undefined)[]): ContextConfig {
	let config: ContextConfig = DEFAULT_CONFIG;
	for (const input of inputs) {
		if (!input) continue;
		config = {
			...config,
			...input,
			cacheTtlSeconds: { ...config.cacheTtlSeconds, ...input.cacheTtlSeconds },
			historian: { ...config.historian, ...input.historian },
		};
	}
	validate(config);
	return config;
}

function validate(config: ContextConfig): void {
	const positive: [string, number][] = [
		["watermarkTokens", config.watermarkTokens],
		["hardCapTokens", config.hardCapTokens],
		["deferMarginTokens", config.deferMarginTokens],
		["keepRecentTokens", config.keepRecentTokens],
		["maskedTokens", config.maskedTokens],
		["pinnedUserTokens", config.pinnedUserTokens],
		["summaryTokens", config.summaryTokens],
		["filesListed", config.filesListed],
		["coldCutMinTokens", config.coldCutMinTokens],
		["taskCutMinTokens", config.taskCutMinTokens],
		["notebookMaxBytes", config.notebookMaxBytes],
		["fallbackCacheTtlSeconds", config.fallbackCacheTtlSeconds],
		["historian.startTokens", config.historian.startTokens],
		["historian.chunkMinTokens", config.historian.chunkMinTokens],
		["historian.chunkMaxTokens", config.historian.chunkMaxTokens],
		["historian.maxOutputTokens", config.historian.maxOutputTokens],
	];
	for (const [name, value] of positive) {
		if (!Number.isFinite(value) || value <= 0)
			throw new Error(`sandy-context: ${name} must be a positive number, got ${value}`);
	}
	// A cache lifetime may be infinite: a cache that never expires.
	for (const [key, ttl] of Object.entries(config.cacheTtlSeconds)) {
		for (const [tier, seconds] of Object.entries(ttl)) {
			if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds <= 0)
				throw new Error(`sandy-context: cacheTtlSeconds.${key}.${tier} must be a positive number, got ${seconds}`);
		}
	}
	if (!(config.notebookReminderAt > 0 && config.notebookReminderAt < 1)) {
		throw new Error(
			`sandy-context: notebookReminderAt must be between 0 and 1 (exclusive), got ${config.notebookReminderAt}`,
		);
	}
	const carried = carriedTokens(config);
	if (carried >= config.watermarkTokens) {
		throw new Error(
			`sandy-context: keepRecent + masked + pinnedUser + summary + skills section + notebook, in provider tokens (${carried}), must stay below watermarkTokens (${config.watermarkTokens}), otherwise every cut is followed by another`,
		);
	}
	if (config.historian.chunkMinTokens > config.historian.chunkMaxTokens) {
		throw new Error("sandy-context: historian.chunkMinTokens must not exceed historian.chunkMaxTokens");
	}
}

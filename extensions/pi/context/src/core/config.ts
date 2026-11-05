import { SKILLS_SECTION_TOKENS } from "./skills.ts";
import { PROVIDER_TOKENS_PER_ESTIMATE } from "./tokens.ts";

/** A model named by a `provider/model` reference. */
export interface ModelRef {
	readonly provider: string;
	readonly id: string;
}

/** The model a `provider/model` reference names; undefined when it is not one (no slash, an empty side, or a space). */
export function parseModelRef(name: string): ModelRef | undefined {
	const slash = name.indexOf("/");
	if (slash <= 0 || slash === name.length - 1 || /\s/.test(name)) return undefined;
	return { provider: name.slice(0, slash), id: name.slice(slash + 1) };
}

export interface HistorianConfig {
	readonly enabled: boolean;
	/**
	 * Ask a summary as a fork of the main model's last request, read from its warm cache, when that is predicted to
	 * cost less than asking the historian model. Off until a live comparison showed the saving.
	 */
	readonly fork: boolean;
	/** `provider/model` used for summaries. Unset: the session's current model. Set and not available: startup fails. */
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

/**
 * The cap on the history a cut keeps verbatim (see kept-cap.ts). `shadow` plans it at every cut and records what it
 * would remove, without changing a cut; `on` cuts from the capped start and refuses to start without a matching passing
 * probe record; `off` does neither.
 */
export interface KeptCapConfig {
	readonly mode: "off" | "shadow" | "on";
	/** The most history a cut keeps, in the provider's tokens like keepRecentTokens, which it must not undercut. */
	readonly tokens: number;
}

export const KEPT_CAP_MODES: readonly KeptCapConfig["mode"][] = ["off", "shadow", "on"];

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
	readonly keptCap: KeptCapConfig;
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
		fork: false,
		startTokens: 60_000,
		chunkMinTokens: 12_000,
		chunkMaxTokens: 40_000,
		maxOutputTokens: 4_096,
	},
	keptCap: { mode: "shadow", tokens: 24_000 },
};

export type ContextConfigInput = Partial<Omit<ContextConfig, "historian" | "cacheTtlSeconds" | "keptCap">> & {
	/** Merged per key over the defaults. */
	readonly cacheTtlSeconds?: Readonly<Record<string, CacheTtl>>;
	readonly historian?: Partial<HistorianConfig>;
	readonly keptCap?: Partial<KeptCapConfig>;
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

/** Settings that must be positive finite numbers, top level. */
const POSITIVE_FIELDS = [
	"watermarkTokens",
	"hardCapTokens",
	"deferMarginTokens",
	"keepRecentTokens",
	"maskedTokens",
	"pinnedUserTokens",
	"summaryTokens",
	"filesListed",
	"coldCutMinTokens",
	"taskCutMinTokens",
	"notebookMaxBytes",
	"fallbackCacheTtlSeconds",
] as const;

const NUMBER_FIELDS: readonly string[] = [...POSITIVE_FIELDS, "notebookReminderAt"];

const HISTORIAN_POSITIVE_FIELDS = ["startTokens", "chunkMinTokens", "chunkMaxTokens", "maxOutputTokens"] as const;
const HISTORIAN_MODEL_FIELDS = ["model", "fallbackModel"] as const;
const CACHE_TIERS = ["short", "long"] as const;

/** Why a config was refused: every problem found, so one run of the host shows them all. */
export interface ConfigErrors {
	readonly configErrors: readonly string[];
}

export function isConfigErrors(result: unknown): result is ConfigErrors {
	return typeof result === "object" && result !== null && "configErrors" in result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
	return JSON.stringify(value) ?? String(value);
}

function unknownFields(record: Record<string, unknown>, known: readonly string[], where: string): string[] {
	return Object.keys(record)
		.filter((key) => !known.includes(key))
		.map((key) => `unknown field ${where}${key} (known: ${known.join(", ")})`);
}

/** Read the shape of one input: every field known and of its type. Wrong fields are reported and left out. */
function readInput(raw: unknown): { readonly input: ContextConfigInput; readonly errors: string[] } {
	const errors: string[] = [];
	if (!isRecord(raw)) return { input: {}, errors: [`must be a JSON object, got ${show(raw)}`] };
	const input: Record<string, unknown> = {};
	const historianKeys = ["enabled", "fork", ...HISTORIAN_MODEL_FIELDS, ...HISTORIAN_POSITIVE_FIELDS];
	errors.push(...unknownFields(raw, [...NUMBER_FIELDS, "cacheTtlSeconds", "historian", "keptCap"], ""));
	for (const key of NUMBER_FIELDS) {
		if (!(key in raw)) continue;
		if (typeof raw[key] === "number") input[key] = raw[key];
		else errors.push(`${key} must be a number, got ${show(raw[key])}`);
	}
	const ttls = raw.cacheTtlSeconds;
	if (ttls !== undefined) {
		if (!isRecord(ttls)) errors.push(`cacheTtlSeconds must be an object, got ${show(ttls)}`);
		else {
			const checked: Record<string, CacheTtl> = {};
			for (const [key, ttl] of Object.entries(ttls)) {
				if (!isRecord(ttl)) {
					errors.push(`cacheTtlSeconds.${key} must be an object, got ${show(ttl)}`);
					continue;
				}
				errors.push(...unknownFields(ttl, CACHE_TIERS, `cacheTtlSeconds.${key}.`));
				const tiers: Record<string, number> = {};
				for (const tier of CACHE_TIERS) {
					if (!(tier in ttl)) continue;
					if (typeof ttl[tier] === "number") tiers[tier] = ttl[tier];
					else errors.push(`cacheTtlSeconds.${key}.${tier} must be a number, got ${show(ttl[tier])}`);
				}
				checked[key] = tiers;
			}
			input.cacheTtlSeconds = checked;
		}
	}
	const keptCap = raw.keptCap;
	if (keptCap !== undefined) {
		if (!isRecord(keptCap)) errors.push(`keptCap must be an object, got ${show(keptCap)}`);
		else {
			errors.push(...unknownFields(keptCap, ["mode", "tokens"], "keptCap."));
			const checked: Record<string, unknown> = {};
			if ("mode" in keptCap) {
				if (KEPT_CAP_MODES.includes(keptCap.mode as KeptCapConfig["mode"])) checked.mode = keptCap.mode;
				else errors.push(`keptCap.mode must be one of ${KEPT_CAP_MODES.join(", ")}, got ${show(keptCap.mode)}`);
			}
			if ("tokens" in keptCap) {
				if (typeof keptCap.tokens === "number") checked.tokens = keptCap.tokens;
				else errors.push(`keptCap.tokens must be a number, got ${show(keptCap.tokens)}`);
			}
			input.keptCap = checked;
		}
	}
	const historian = raw.historian;
	if (historian !== undefined) {
		if (!isRecord(historian)) errors.push(`historian must be an object, got ${show(historian)}`);
		else {
			errors.push(...unknownFields(historian, historianKeys, "historian."));
			const checked: Record<string, unknown> = {};
			for (const key of ["enabled", "fork"] as const) {
				if (!(key in historian)) continue;
				if (typeof historian[key] === "boolean") checked[key] = historian[key];
				else errors.push(`historian.${key} must be true or false, got ${show(historian[key])}`);
			}
			for (const key of HISTORIAN_POSITIVE_FIELDS) {
				if (!(key in historian)) continue;
				if (typeof historian[key] === "number") checked[key] = historian[key];
				else errors.push(`historian.${key} must be a number, got ${show(historian[key])}`);
			}
			for (const key of HISTORIAN_MODEL_FIELDS) {
				if (!(key in historian)) continue;
				const value = historian[key];
				if (typeof value === "string" && parseModelRef(value)) checked[key] = value;
				else errors.push(`historian.${key} must be a provider/model reference such as "anthropic/claude-haiku", got ${show(value)}`);
			}
			input.historian = checked;
		}
	}
	return { input: input as ContextConfigInput, errors };
}

function merge(config: ContextConfig, input: ContextConfigInput): ContextConfig {
	return {
		...config,
		...input,
		cacheTtlSeconds: { ...config.cacheTtlSeconds, ...input.cacheTtlSeconds },
		historian: { ...config.historian, ...input.historian },
		keptCap: { ...config.keptCap, ...input.keptCap },
	};
}

/**
 * Read a config from untrusted input (a parsed JSON file) and the embedder's overrides over the defaults. Unknown
 * fields, wrong types, malformed model references and settings that cannot work are all errors, reported together;
 * nothing is dropped silently.
 */
export function parseConfig(input: unknown, overrides?: unknown): ContextConfig | ConfigErrors {
	const file = readInput(input);
	const embedded = overrides === undefined ? { input: {}, errors: [] } : readInput(overrides);
	const errors = [...file.errors, ...embedded.errors.map((error) => `options.config: ${error}`)];
	const config = merge(merge(DEFAULT_CONFIG, file.input), embedded.input);
	errors.push(...validate(config));
	return errors.length > 0 ? { configErrors: errors } : config;
}

/** Merge typed inputs left to right over the defaults and reject settings that cannot work. */
export function resolveConfig(...inputs: readonly (ContextConfigInput | undefined)[]): ContextConfig {
	let config: ContextConfig = DEFAULT_CONFIG;
	for (const input of inputs) if (input) config = merge(config, input);
	const errors = validate(config);
	if (errors.length > 0) throw new Error(`context: ${errors.join("; ")}`);
	return config;
}

/** Every reason the settings cannot work, none when they can. */
function validate(config: ContextConfig): string[] {
	const errors: string[] = [];
	const positive: [string, number][] = [
		...POSITIVE_FIELDS.map((name): [string, number] => [name, config[name]]),
		...HISTORIAN_POSITIVE_FIELDS.map((name): [string, number] => [`historian.${name}`, config.historian[name]]),
	];
	for (const [name, value] of positive) {
		if (!Number.isFinite(value) || value <= 0) errors.push(`${name} must be a positive number, got ${value}`);
	}
	// A cache lifetime may be infinite: a cache that never expires.
	for (const [key, ttl] of Object.entries(config.cacheTtlSeconds)) {
		for (const [tier, seconds] of Object.entries(ttl)) {
			if (typeof seconds !== "number" || Number.isNaN(seconds) || seconds <= 0)
				errors.push(`cacheTtlSeconds.${key}.${tier} must be a positive number, got ${seconds}`);
		}
	}
	if (!(config.notebookReminderAt > 0 && config.notebookReminderAt < 1)) {
		errors.push(`notebookReminderAt must be between 0 and 1 (exclusive), got ${config.notebookReminderAt}`);
	}
	const carried = carriedTokens(config);
	if (carried >= config.watermarkTokens) {
		errors.push(
			`keepRecent + masked + pinnedUser + summary + skills section + notebook, in provider tokens (${carried}), must stay below watermarkTokens (${config.watermarkTokens}), otherwise every cut is followed by another`,
		);
	}
	const cap = config.keptCap.tokens;
	if (!Number.isFinite(cap) || cap < config.keepRecentTokens) {
		errors.push(`keptCap.tokens (${cap}) must be a number of at least keepRecentTokens (${config.keepRecentTokens}): a cap below what a cut keeps anyway would cut inside every kept range`);
	}
	if (config.historian.chunkMinTokens > config.historian.chunkMaxTokens) {
		errors.push("historian.chunkMinTokens must not exceed historian.chunkMaxTokens");
	}
	return errors;
}

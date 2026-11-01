import { readFileSync } from "node:fs";

export interface AdvisorConfig {
	enabled: boolean;
	model: { provider: string; id: string; reasoning: string };
	gate: { enabled: boolean; mode: "rewrite" | "annotate"; timeoutMs: number; minChars: number; onTimeout: "release" | "annotate-rules"; rules: Record<string, boolean> };
	review: { enabled: boolean; everyTurns: number; immuneTurns: number; maxNotesPerRun: number; steer: boolean; timeoutMs: number };
	proposals: { enabled: boolean; maxPerSession: number; taskProject: string };
	/** The advisor as a full agent session. tools are read-only built-ins; off falls back to a bare model call. */
	agent: { enabled: boolean; tools: string[]; maxToolCalls: number; contextFiles: boolean; contextPlugin: boolean; recallPrimary: boolean; promote: { provider: string; id: string; atTokens: number } };
	cache: { retention: "short" | "long"; budgetTokens: number; toolResultMaxChars: number; textMaxChars: number; maxOutputTokens: number };
}

export const DEFAULTS: AdvisorConfig = {
	enabled: true,
	model: { provider: "openai", id: "gpt-6-sol", reasoning: "medium" },
	gate: { enabled: true, mode: "rewrite", timeoutMs: 12000, minChars: 200, onTimeout: "release", rules: { tests_pass: true, file_changed: true, shipped: true, verified: true } },
	review: { enabled: true, everyTurns: 4, immuneTurns: 3, maxNotesPerRun: 4, steer: true, timeoutMs: 60000 },
	proposals: { enabled: true, maxPerSession: 5, taskProject: "IDEA" },
	agent: { enabled: true, tools: ["read", "grep", "find", "ls"], maxToolCalls: 6, contextFiles: true, contextPlugin: true, recallPrimary: true, promote: { provider: "", id: "", atTokens: 200000 } },
	cache: { retention: "long", budgetTokens: 120000, toolResultMaxChars: 1200, textMaxChars: 6000, maxOutputTokens: 1500 },
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge that keeps only keys the defaults know and values of the same type; every rejected value becomes an error string. */
export function merge<T>(base: T, over: unknown, path = "", errors: string[] = []): T {
	if (over === undefined) return base;
	if (!isObj(base) || !isObj(over)) {
		if (typeof over === typeof base) return over as T;
		errors.push(`${path || "config"}: expected ${typeof base}, got ${typeof over}`);
		return base;
	}
	const out: Record<string, unknown> = { ...base };
	for (const [k, v] of Object.entries(over)) {
		if (!(k in base) && path !== "gate.rules") {
			errors.push(`${path ? path + "." : ""}${k}: unknown key`);
			continue;
		}
		out[k] = merge((base as Record<string, unknown>)[k] ?? false, v, path ? `${path}.${k}` : k, errors);
	}
	return out as T;
}

export interface Loaded {
	config: AdvisorConfig;
	errors: string[];
}

/** Later files win. A missing file is fine; a broken one is reported and skipped. */
export function loadConfig(paths: string[], read: (p: string) => string = (p) => readFileSync(p, "utf8")): Loaded {
	let config = DEFAULTS;
	const errors: string[] = [];
	for (const p of paths) {
		let raw: string;
		try {
			raw = read(p);
		} catch {
			continue;
		}
		try {
			config = merge(config, JSON.parse(raw), "", errors);
		} catch (e) {
			errors.push(`${p}: ${(e as Error).message}`);
		}
	}
	return { config, errors };
}

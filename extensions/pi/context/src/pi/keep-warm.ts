import { existsSync, readFileSync } from "node:fs";
import { KEEP_WARM_KIND } from "../core/kinds.ts";
import type { CacheTier } from "../core/policy.ts";

/** The ping's prompt: the cheapest turn that still reads the whole cached prompt. */
export const KEEP_WARM_PING = "Keep-warm ping from the context engine, not from the user. Reply only with: ok";

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

interface ContextMessage {
	readonly role: string;
	readonly customType?: string;
}

/**
 * The messages without answered pings. A ping and its answer stay in the session but leave the model's context once
 * the next prompt arrives: the ping read the prompt before it, so that prefix is what the cache holds.
 */
export function withoutPings<M extends ContextMessage>(messages: readonly M[]): M[] {
	const kept: M[] = [];
	for (let index = 0; index < messages.length; index++) {
		if (messages[index]?.role !== "custom" || messages[index]?.customType !== KEEP_WARM_KIND) {
			kept.push(messages[index] as M);
			continue;
		}
		let end = index + 1;
		while (end < messages.length && ["assistant", "toolResult"].includes(messages[end]?.role ?? "")) end++;
		if (end === messages.length) return [...kept, ...messages.slice(index)];
		index = end - 1;
	}
	return kept;
}

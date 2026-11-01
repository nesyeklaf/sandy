/**
 * Provider tokens per estimated token. Budgets are set in the provider's tokens, the unit of the watermark, and the
 * cut measures text by {@link estimateTokens}. Fitted on 86 cuts of Opus sessions (October 2026): a prompt came to
 * about 48k tokens of system prompt and tools plus 1.3 to 1.5 times the estimate of the messages; code, JSON and
 * German text reach 1.8. The higher value keeps a cut on the small side.
 */
export const PROVIDER_TOKENS_PER_ESTIMATE = 1.6;

/** A budget set in provider tokens, in estimated tokens. */
export function estimateBudget(providerTokens: number): number {
	return Math.floor(providerTokens / PROVIDER_TOKENS_PER_ESTIMATE);
}

/** Token estimate used for every budget: four characters per token, the rule pi uses as well. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

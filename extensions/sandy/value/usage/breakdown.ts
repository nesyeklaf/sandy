// One turn's token usage, reduced to the three parts the page draws.
//
// Providers report the same tokens differently. Claude Code's inputTokens
// excludes cached input and reports cache reads and writes separately; Codex's
// inputTokens includes the cached part and reports only cachedInputTokens.
// totalTokens is input plus output for both, so "new input" is whatever is
// left of the total once output and cache reads are taken out.

/** The fields of sandy's token usage breakdown this plugin reads. */
export interface ProviderTokenBreakdown {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export interface Tokens {
  /** Input the model read fresh, including tokens written to the cache. */
  input: number;
  /** Input served from the prompt cache. */
  cacheRead: number;
  output: number;
}

export const ZERO_TOKENS: Tokens = { input: 0, cacheRead: 0, output: 0 };

function count(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function splitBreakdown(breakdown: ProviderTokenBreakdown): Tokens {
  const total = count(breakdown.totalTokens);
  const output = Math.min(count(breakdown.outputTokens), total);
  const cacheRead = Math.min(
    count(breakdown.cacheReadInputTokens ?? breakdown.cachedInputTokens),
    total - output,
  );
  return { input: total - output - cacheRead, cacheRead, output };
}

export function totalOf(tokens: Tokens): number {
  return tokens.input + tokens.cacheRead + tokens.output;
}

export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    output: a.output + b.output,
  };
}

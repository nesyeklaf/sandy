// What a turn would cost at list price. Pi reports tokens only, so the dollars
// are computed here. Pure: prices in, dollars out.

/** US dollars per million tokens. */
export interface Price {
  input: number;
  cacheRead: number;
  output: number;
  /** Replaces the rates above for a turn whose context (input plus cache reads) is larger than `above`. */
  tier?: { above: number; input: number; cacheRead: number; output: number };
}

export type PriceTable = Record<string, Price>;

const LONG_CONTEXT = 272_000;

function price(input: number, cacheRead: number, output: number, tier?: [number, number, number], above = LONG_CONTEXT): Price {
  return tier === undefined
    ? { input, cacheRead, output }
    : { input, cacheRead, output, tier: { above, input: tier[0], cacheRead: tier[1], output: tier[2] } };
}

/**
 * List prices of the models in use, from the models.dev snapshot that ccusage
 * ships. Cache writes are not priced apart: sandy counts them as input. A model
 * missing here is "unpriced", never free; the `prices` setting adds or
 * overrides entries.
 */
export const DEFAULT_PRICES: PriceTable = {
  "gpt-5.6": price(4, 0.4, 20, [8, 0.8, 30]),
  "gpt-5.6-sol": price(4, 0.4, 20, [8, 0.8, 30]),
  "gpt-5.6-terra": price(2, 0.2, 12, [4, 0.4, 18]),
  "gpt-5.6-luna": price(0.2, 0.02, 1.2, [0.4, 0.04, 1.8]),
  "gpt-6-sol": price(2, 0.2, 10, [4, 0.4, 15]),
  "gpt-6-astra": price(10, 1, 50, [20, 2, 75]),
  "gpt-6-luna": price(0.1, 0.01, 0.5, [0.2, 0.02, 0.75]),
  // From the providers' price pages, 2026-10-28: GPT-6.1 Sol doubles input and cache above 272K and
  // charges 1.5x output; Haiku 5.5 charges 5x above 100K, the whole request.
  "gpt-6.1-sol": price(2, 0.1, 10, [4, 0.2, 15]),
  "claude-haiku-5-5": price(0.1, 0.01, 0.5, [0.5, 0.05, 2.5], 100_000),
  "claude-fable-5": price(10, 1, 50),
  "claude-fable-5-1": price(10, 0.25, 50),
  "claude-opus-5": price(5, 0.5, 25),
  "claude-opus-5-5": price(4, 0.2, 20),
  "claude-sonnet-5": price(2, 0.2, 10),
  "claude-sonnet-5-5": price(2, 0.1, 10),
};

/**
 * Parses the `prices` setting: one model per line as `model input cacheRead output`
 * in dollars per million tokens, `#` starts a comment. Lines that do not parse are returned apart.
 */
export function parsePrices(text: string): { prices: PriceTable; invalid: string[] } {
  const prices: PriceTable = {};
  const invalid: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (line === "") continue;
    const [model, ...rest] = line.split(/\s+/);
    const numbers = rest.map(Number);
    if (model === undefined || numbers.length !== 3 || numbers.some((n) => !Number.isFinite(n) || n < 0)) {
      invalid.push(line);
      continue;
    }
    prices[normalizeModel(model)] = { input: numbers[0]!, cacheRead: numbers[1]!, output: numbers[2]! };
  }
  return { prices, invalid };
}

/** How much more a model's "-fast" variant costs than its base model. */
const FAST_MULTIPLIER: Record<string, number> = {
  "gpt-5.6-sol": 2,
  "gpt-5.6-terra": 2,
  "gpt-5.6-luna": 2,
  "gpt-6-astra": 2,
};

/** The model id without a provider prefix, a "@region" suffix and case. */
export function normalizeModel(model: string): string {
  const base = model.trim().toLowerCase().split("@")[0]!;
  return base.slice(base.lastIndexOf("/") + 1);
}

/** The price of a model, or null when none is known. A "-fast" variant of a known model gets its multiplier. */
export function priceOf(model: string | null, table: PriceTable = DEFAULT_PRICES): Price | null {
  if (model === null) return null;
  const id = normalizeModel(model);
  const direct = table[id];
  if (direct !== undefined) return direct;
  if (id.endsWith("-fast")) {
    const base = id.slice(0, -"-fast".length);
    const basePrice = table[base];
    const factor = FAST_MULTIPLIER[base];
    if (basePrice !== undefined && factor !== undefined) return scaled(basePrice, factor);
  }
  return null;
}

function scaled(base: Price, factor: number): Price {
  const scale = (value: number) => value * factor;
  return {
    input: scale(base.input),
    cacheRead: scale(base.cacheRead),
    output: scale(base.output),
    ...(base.tier === undefined
      ? {}
      : { tier: { above: base.tier.above, input: scale(base.tier.input), cacheRead: scale(base.tier.cacheRead), output: scale(base.tier.output) } }),
  };
}

/** The list-price cost in US dollars of one turn's tokens. */
export function costOf(tokens: { input: number; cacheRead: number; output: number }, rate: Price): number {
  const long = rate.tier !== undefined && tokens.input + tokens.cacheRead > rate.tier.above;
  const use = long && rate.tier !== undefined ? rate.tier : rate;
  return (tokens.input * use.input + tokens.cacheRead * use.cacheRead + tokens.output * use.output) / 1_000_000;
}

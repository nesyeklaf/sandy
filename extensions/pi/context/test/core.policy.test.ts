import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	type CutEnvelope,
	cutFrees,
	cutThresholds,
	envelopeHolds,
	expectedTokens,
	nativeLimit,
	PI_RESERVE,
	projectedTokens,
} from "../src/core/policy.ts";
import { PROVIDER_TOKENS_PER_ESTIMATE } from "../src/core/tokens.ts";
import { small } from "./support/core.ts";

/*
 * The cut envelope: what every request after a cut carries besides the log (system prompt, tools) and the room pi
 * keeps for the answer. A cut is judged by the prompt it is expected to leave in that envelope.
 */

const envelope = (fixedTokens: number, contextWindow: number | undefined = 200_000, reserveTokens = PI_RESERVE) =>
	({ fixedTokens, reserveTokens, contextWindow }) satisfies CutEnvelope;

describe("the cut envelope", () => {
	it("places pi's own compaction at the window minus the reserve the session resolved", () => {
		assert.equal(nativeLimit(envelope(0, 200_000, 16_384)), 183_616);
		assert.equal(nativeLimit(envelope(0, 200_000, 4_000)), 196_000);
		assert.equal(nativeLimit({ fixedTokens: 0, reserveTokens: PI_RESERVE, contextWindow: undefined }), Number.POSITIVE_INFINITY);
	});

	it("derives the hard threshold from the real reserve, not pi's default", () => {
		const config = { ...small, watermarkTokens: 100_000, deferMarginTokens: 50_000, hardCapTokens: 400_000 };
		assert.equal(cutThresholds(config, 160_000).hard, 160_000 - 2 * PI_RESERVE);
		assert.equal(cutThresholds(config, 160_000, 4_000).hard, 150_000);
		assert.equal(cutThresholds(config, 160_000, 40_000).hard, 80_000);
		assert.equal(cutThresholds(config, 160_000, 40_000).soft, 80_000);
	});

	it("never expects less than the system prompt, tools and what the cut carries", () => {
		const remainder = { contextTokens: 60_000, visibleTokens: 10_000, archivedTokens: 8_000, blockTokens: 500, keptTokens: 1_500 };
		// The ratio 6.0 comes mostly from a 40k system prompt; the projection would claim the cut frees 45k.
		assert.equal(projectedTokens(remainder), 15_000);
		assert.equal(expectedTokens(remainder, envelope(40_000)), 42_000);
		// With a small system prompt the measured projection stands.
		assert.equal(expectedTokens(remainder, envelope(1_000)), 15_000);
	});

	it("scales the estimate when the provider has not counted the prompt yet", () => {
		const remainder = { contextTokens: undefined, visibleTokens: 10_000, archivedTokens: 8_000, blockTokens: 500, keptTokens: 1_500 };
		assert.equal(expectedTokens(remainder, envelope(3_000)), 3_000 + 2_000 * PROVIDER_TOKENS_PER_ESTIMATE);
	});

	it("frees headroom below the limit, or a quarter of the prompt from the hard threshold on", () => {
		assert.equal(cutFrees(19_999, 30_000, 20_000, 40_000), true);
		assert.equal(cutFrees(25_000, 30_000, 20_000, 40_000), false, "misses the limit below hard");
		assert.equal(cutFrees(30_000, 40_000, 20_000, 40_000), true, "frees a quarter at hard");
		assert.equal(cutFrees(31_000, 40_000, 20_000, 40_000), false, "frees less than a quarter at hard");
	});

	it("holds only when system prompt, tools and carry fit below the watermark and pi's own compaction", () => {
		assert.equal(envelopeHolds(small, envelope(1_000), small.watermarkTokens), true);
		assert.equal(envelopeHolds(small, envelope(small.watermarkTokens), small.watermarkTokens), false);
		assert.equal(envelopeHolds(small, envelope(1_000, 20_000, 16_000), small.watermarkTokens), false, "window too small");
	});
});

import { resolveConfig } from "../../src/core/config.ts";

/** A config small enough that a dozen short entries cross every threshold. */
export const small = resolveConfig({
	watermarkTokens: 20_000,
	keepRecentTokens: 4_000,
	maskedTokens: 600,
	pinnedUserTokens: 300,
	summaryTokens: 400,
	coldCutMinTokens: 8_000,
	historian: { chunkMinTokens: 2_000, chunkMaxTokens: 5_000 },
});

// A cut planned from a log alone: no model, no network.
//
//   node --experimental-strip-types examples/plan-cut.ts
//
// A synthetic session of 40 turns, each reading a file of about 1,000 tokens, grows past a small
// watermark. The cut keeps the newest turns verbatim and carries the rest forward as the notebook,
// earlier user messages, the files touched and a masked transcript.
import {
	boundaryCut,
	cutThresholds,
	effectiveWatermark,
	estimateTokens,
	type LogEntry,
	foldCut,
	resolveConfig,
} from "../src/core/index.ts";

const config = resolveConfig({
	watermarkTokens: 20_000,
	keepRecentTokens: 4_000,
	maskedTokens: 600,
	pinnedUserTokens: 300,
	summaryTokens: 400,
	coldCutMinTokens: 8_000,
	historian: { chunkMinTokens: 2_000, chunkMaxTokens: 5_000 },
});

const entries: LogEntry[] = [];
const start = Date.UTC(2026, 9, 17, 9, 0, 0);
function add(id: string, kind: LogEntry["kind"], text: string, extra: Partial<LogEntry> = {}): void {
	entries.push({
		id,
		kind,
		timestamp: start + entries.length * 60_000,
		text,
		toolCalls: [],
		tokens: estimateTokens(text),
		...extra,
	});
}
for (let turn = 0; turn < 40; turn++) {
	add(`u${turn}`, "user", `What does module-${turn} export?`);
	add(`a${turn}`, "assistant", `Reading module-${turn}.`, {
		toolCalls: [{ id: `c${turn}`, name: "read", args: { path: `src/module-${turn}.ts` } }],
	});
	add(`t${turn}`, "tool", `export const fact${turn} = ${turn};\n${"// body\n".repeat(500)}`, { toolName: "read" });
	add(`r${turn}`, "assistant", `module-${turn} exports fact${turn}.`);
}

const promptTokens = entries.reduce((sum, entry) => sum + entry.tokens, 0);
const watermark = effectiveWatermark(config, 200_000);
console.log(`prompt ${promptTokens} tokens, watermark ${watermark}: cut due = ${boundaryCut(promptTokens, cutThresholds(config, 200_000), false)}`);

const plan = foldCut({
	entries,
	minKeptIndex: 0,
	visibleFromIndex: 0,
	config,
	reason: "watermark",
	notebook: "Goal: list every export.",
});
if (!plan) throw new Error("expected a cut");
const kept = entries.findIndex((entry) => entry.id === plan.firstKeptEntryId);
const keptTokens = entries.slice(kept).reduce((sum, entry) => sum + entry.tokens, 0);
console.log(`kept from #${plan.firstKeptEntryId}: ${entries.length - kept} entries, ${keptTokens} tokens verbatim`);
console.log(`carried block: ${plan.details.blockTokens} tokens for ${plan.details.archivedEntries} archived entries\n`);
console.log(plan.text);

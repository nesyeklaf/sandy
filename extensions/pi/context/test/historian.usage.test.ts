import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveConfig } from "../src/core/config.ts";
import { accountingEvents, reduceAccounting } from "../src/core/accounting.ts";
import { attemptRecords, echo, harness } from "./support/historian.ts";
import { piUsage } from "./support/accounting.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * What a historian request cost is stored with its attempt record, so a failed, rejected or stale request is a charge
 * the report can count and not a request that vanished.
 */
describe("the attempt record carries the usage of its request", () => {
	const config = resolveConfig({
		keepRecentTokens: 1_000,
		maskedTokens: 500,
		pinnedUserTokens: 1_000,
		historian: { chunkMinTokens: 100, chunkMaxTokens: 40_000 },
	});
	const session = () => {
		const log = sessionLog();
		for (const label of ["a", "b", "c", "d", "e", "f"]) log.turn(label, 2_000);
		return log;
	};
	const ends = (log: ReturnType<typeof session>) => attemptRecords(log).filter((record) => record.type === "end");

	it("a stored answer's end record names the usage of the answer", async () => {
		const log = session();
		const run = harness(log, config, { answer: (request) => ({ text: echo(request.prompt), usage: piUsage(3, 11, 7, 5, 2) }) });
		await run.run();
		assert.deepEqual(
			ends(log).map((record) => record.type === "end" && record.outcome),
			["stored"],
		);
		assert.deepEqual((ends(log)[0] as { usage?: unknown }).usage, { input: 11, output: 7, cacheRead: 5, cacheWrite: 2, cost: 3 });
	});

	it("a failed request's end record names the usage its error carries", async () => {
		const log = session();
		const run = harness(log, config, {
			answer: () => {
				throw Object.assign(new Error("hit the output limit"), { usage: piUsage(3) });
			},
		});
		await run.run();
		const [end] = ends(log);
		assert.equal(end?.type === "end" && end.outcome, "failed");
		assert.deepEqual((end as { usage?: unknown }).usage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 3 });
	});

	it("a failed request that reports no usage ends without one, which the report counts as unknown", async () => {
		const log = session();
		const run = harness(log, config, {
			answer: () => {
				throw new Error("connection reset");
			},
		});
		await run.run();
		const [end] = ends(log);
		assert.equal(end?.type === "end" && "usage" in end, false);
		const report = reduceAccounting(accountingEvents(log.manager.getEntries()));
		assert.equal(report.unknown, 1);
		assert.equal(report.total, undefined);
	});

	it("a failed attempt's usage lands in the historian line of the cost report", async () => {
		const log = session();
		const run = harness(log, config, {
			answer: () => {
				throw Object.assign(new Error("rejected by the provider"), { usage: piUsage(3) });
			},
		});
		await run.run();
		const report = reduceAccounting(accountingEvents(log.manager.getEntries()));
		assert.equal(report.bySource.historian.cost, 3);
		assert.equal(report.complete, true);
	});
});

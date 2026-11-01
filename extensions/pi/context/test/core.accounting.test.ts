import { describe, expect, it } from "vitest";
import { accountingEvents, formatCostReport, reduceAccounting } from "../src/core/accounting.ts";
import {
	assistant,
	attempt,
	branchSummary,
	compaction,
	ping,
	sideWarm,
	piUsage,
	type RawEntry,
	summaryRecord,
	toolCall,
	toolResult,
	totals,
	user,
	warming,
	warmUsage,
} from "./support/accounting.ts";

const report = (...entries: (RawEntry | RawEntry[])[]) => reduceAccounting(accountingEvents(entries.flat()));

describe("the cost report of a session", () => {
	it("adds an agent cost of 2 and a failed historian attempt of 3 to 5", () => {
		const r = report(user(), assistant(2), attempt("a1", "failed", totals(3)));
		expect(r.knownSubtotal).toBe(5);
		expect(r.total).toBe(5);
		expect(r.complete).toBe(true);
		expect(r.bySource.main).toMatchObject({ requests: 1, cost: 2 });
		expect(r.bySource.historian).toMatchObject({ requests: 1, cost: 3 });
	});

	it("labels every cost as catalogue price, not billed cash", () => {
		expect(report(assistant(1)).priceBasis).toBe("catalogue");
		expect(formatCostReport(report(assistant(1))).join("\n")).toMatch(/catalogue/i);
	});

	it("counts each paid request once, whichever process or branch recorded it", () => {
		const answer = assistant(2);
		const twice = [answer, answer, ...attempt("a1", "stale", totals(3)), ...attempt("a1", "stale", totals(3))];
		const r = report(twice);
		expect(r.requests).toBe(2);
		expect(r.knownSubtotal).toBe(5);
	});

	it("counts the historian's every route, the condenser, and rejected, failed and stale attempts", () => {
		const r = report(
			attempt("s1", "stored", totals(1), "summarize", "primary"),
			attempt("s2", "rejected", totals(2), "summarize", "fallback"),
			attempt("s3", "failed", totals(4), "summarize", "fork"),
			attempt("s4", "stale", totals(8), "summarize", "primary"),
			attempt("c1", "stored", totals(16), "condense", "primary"),
		);
		expect(r.bySource.historian).toMatchObject({ requests: 4, cost: 15 });
		expect(r.bySource.condenser).toMatchObject({ requests: 1, cost: 16 });
		expect(r.total).toBe(31);
		expect(r.piCounted.cost).toBe(0);
		expect(r.engineCounted.cost).toBe(31);
	});

	it("never turns an unknown charge into zero", () => {
		const unknowns = [
			["a failed attempt without usage", attempt("u1", "failed")],
			["an attempt that never ended", attempt("u2", false)],
			["an aborted attempt", attempt("u3", "aborted")],
			["a stored attempt from before usage was recorded", attempt("u4", "stored")],
		] as const;
		for (const [name, entries] of unknowns) {
			const r = report(assistant(2), entries);
			expect(r.unknown, name).toBe(1);
			expect(r.complete, name).toBe(false);
			expect(r.total, name).toBeUndefined();
			expect(r.knownSubtotal, name).toBe(2);
		}
		const lines = formatCostReport(report(assistant(2), attempt("u1", "failed"))).join("\n");
		expect(lines).toMatch(/incomplete/i);
		expect(lines).not.toMatch(/total/i);
	});

	it("counts the keep-warm ping's turn as the ping, not as the agent", () => {
		const r = report(user(), assistant(1), ping(), assistant(2, {}, [{ type: "toolCall", id: "c", name: "read", arguments: {} }]), toolResult("c", "read"), assistant(4), user(), assistant(8));
		expect(r.bySource["keep-warm"]).toMatchObject({ requests: 2, cost: 6 });
		expect(r.bySource.main).toMatchObject({ requests: 2, cost: 9 });
		expect(r.complete).toBe(true);
	});

	it("takes a ping that got no answer as an unknown attempt", () => {
		const r = report(user(), assistant(1), ping(), user());
		expect(r.bySource["keep-warm"]).toMatchObject({ requests: 1, unknown: 1 });
		expect(r.complete).toBe(false);
	});

	it("charges a side-request ping to the keep-warm source, counted by the engine, and keeps old ping turns readable", () => {
		const usage = { input: 4, output: 1, cacheRead: 900, cacheWrite: 0, cost: 0.5 };
		const r = report(user(), assistant(1), ...sideWarm("w1", "warmed", usage), user(), assistant(2));
		expect(r.bySource["keep-warm"]).toMatchObject({ requests: 1, cost: 0.5 });
		expect(r.engineCounted.cacheRead).toBe(900);
		expect(r.piCounted.cacheRead).toBe(0);
		expect(r.bySource.main.requests).toBe(2);
		expect(r.complete).toBe(true);
	});

	it("takes a side-request ping with no end, or an end without usage, as an unknown charge", () => {
		expect(report(user(), assistant(1), ...sideWarm("w1", false)).bySource["keep-warm"]).toMatchObject({ requests: 1, unknown: 1 });
		expect(report(user(), assistant(1), ...sideWarm("w1", "failed")).bySource["keep-warm"]).toMatchObject({ requests: 1, unknown: 1 });
	});

	describe("the usage a summary carries", () => {
		it("counts the requests of a summary stored with no attempt receipts, under either record name", () => {
			const r = report(user(), summaryRecord(piUsage(3), piUsage(2)), summaryRecord(piUsage(4), undefined, "sandy-context.summary"));
			expect(r.bySource.historian).toMatchObject({ requests: 2, known: 2, cost: 7 });
			expect(r.bySource.condenser).toMatchObject({ requests: 1, known: 1, cost: 2 });
			expect(r.engineCounted.cost).toBe(9);
			expect(r.complete).toBe(true);
			expect(r.total).toBe(9);
		});

		it("counts a request once when its attempt receipt and its summary both tell of it", () => {
			const r = report(
				user(),
				attempt("s1", "stored", totals(3), "summarize"),
				attempt("c1", "stored", totals(2), "condense"),
				summaryRecord(piUsage(3), piUsage(2)),
			);
			expect(r.bySource.historian).toMatchObject({ requests: 1, cost: 3 });
			expect(r.bySource.condenser).toMatchObject({ requests: 1, cost: 2 });
			expect(r.total).toBe(5);
		});

		it("counts the summaries from before receipts next to those with receipts in one session", () => {
			const r = report(summaryRecord(piUsage(4)), attempt("s1", "stored", totals(3)), summaryRecord(piUsage(3)));
			expect(r.bySource.historian).toMatchObject({ requests: 2, cost: 7 });
			expect(r.total).toBe(7);
		});

		it("does not let an attempt that stored nothing answer for a summary", () => {
			const r = report(attempt("s1", "stale", totals(3)), summaryRecord(piUsage(3)));
			expect(r.bySource.historian).toMatchObject({ requests: 2, cost: 6 });
		});

		it("takes a summary with no readable usage and no receipt as an unknown charge, never a complete zero", () => {
			const r = report(summaryRecord(), summaryRecord({ input: "many" }, { cost: 1 }));
			expect(r.bySource.historian).toMatchObject({ requests: 2, unknown: 2 });
			expect(r.bySource.condenser).toMatchObject({ requests: 1, unknown: 1 });
			expect(r.complete).toBe(false);
			expect(r.total).toBeUndefined();
		});

		it("takes a receipt without usage and the summary that has none as one unknown charge", () => {
			const r = report(attempt("s1", "stored"), summaryRecord());
			expect(r.bySource.historian).toMatchObject({ requests: 1, unknown: 1 });
		});
	});

	describe("native cache warming", () => {
		it("counts a warm whose usage pi persisted as a known charge pi also counts", () => {
			const r = report(assistant(1), warming({ piAction: "warm", action: "warm" }), warmUsage(2));
			expect(r.bySource["native-warm"]).toMatchObject({ requests: 1, known: 1, cost: 2 });
			expect(r.piCounted.cost).toBe(3);
			expect(r.complete).toBe(true);
		});

		it("takes a warm that left no usage (failed, cancelled, still out) as an unknown attempt", () => {
			const failed = report(warming({ piAction: "warm", action: "warm" }));
			expect(failed.bySource["native-warm"]).toMatchObject({ requests: 1, unknown: 1 });
			expect(failed.complete).toBe(false);
			// A warm followed by the next decision without usage in between was cancelled or failed.
			const cancelled = report(warming({ piAction: "warm", action: "warm" }), user(), warming({ piAction: "warm", action: "warm" }), warmUsage(2));
			expect(cancelled.bySource["native-warm"]).toMatchObject({ requests: 2, known: 1, unknown: 1, cost: 2 });
		});

		it("counts pi's policy stop and our own veto as known skips that keep the bill complete", () => {
			const r = report(assistant(1), warming({ piAction: "stop", action: "stop", requestsSeen: true }), user(), assistant(0), warming({ piAction: "warm", action: "stop", veto: true, requestsSeen: true }));
			expect(r.skipped).toBe(2);
			expect(r.unknown).toBe(0);
			expect(r.complete).toBe(true);
			expect(r.total).toBe(1);
		});

		it("takes a stop that a later handler overrode as the warm it became", () => {
			const r = report(warming({ piAction: "warm", action: "stop", veto: true, requestsSeen: true }), warmUsage(2, "extension override"));
			expect(r.skipped).toBe(0);
			expect(r.bySource["native-warm"]).toMatchObject({ known: 1, cost: 2 });
		});
	});

	describe("a stop a later handler overrode", () => {
		it("takes a stop recorded without sight of the requests as unknown, not as a skip", () => {
			const r = report(assistant(1), warming({ piAction: "stop", action: "stop" }), user());
			expect(r.skipped).toBe(0);
			expect(r.bySource["native-warm"]).toMatchObject({ requests: 1, unknown: 1 });
			expect(r.complete).toBe(false);
		});

		it("takes the warm that left after a stop as the request it is, paid when its usage came", () => {
			const sent = warming({ piAction: "stop", action: "warm", requestsSeen: true, sent: true });
			const paid = report(assistant(1), warming({ piAction: "stop", action: "stop", requestsSeen: true }), sent, warmUsage(2, "extension override"), user());
			expect(paid.skipped).toBe(0);
			expect(paid.bySource["native-warm"]).toMatchObject({ requests: 1, known: 1, unknown: 0, cost: 2 });
			expect(paid.complete).toBe(true);
			expect(paid.total).toBe(3);
		});

		it("takes the warm that left after a stop and failed as an unknown attempt, not as a skip", () => {
			const sent = warming({ piAction: "stop", action: "warm", requestsSeen: true, sent: true });
			const r = report(assistant(1), warming({ piAction: "stop", action: "stop", requestsSeen: true }), sent, user());
			expect(r.skipped).toBe(0);
			expect(r.bySource["native-warm"]).toMatchObject({ requests: 1, unknown: 1 });
			expect(r.complete).toBe(false);
		});
	});

	describe("a failed request", () => {
		const failed = (stopReason: string, usage = piUsage(0, 0, 0)) => ({ type: "message", id: "f" + stopReason, message: { role: "assistant", content: [], usage, stopReason } });

		it("takes an errored or aborted answer with pi-ai's default zero usage as unknown", () => {
			for (const reason of ["error", "aborted"]) {
				const r = report(user(), failed(reason));
				expect(r.bySource.main).toMatchObject({ requests: 1, known: 0, unknown: 1 });
				expect(r.complete).toBe(false);
				expect(r.total).toBeUndefined();
			}
		});

		it("keeps the usage a failed answer did report, and a successful zero-cost answer as known", () => {
			const reported = report(failed("error", piUsage(4, 100, 0)));
			expect(reported.bySource.main).toMatchObject({ known: 1, unknown: 0, cost: 4 });
			const free = report({ type: "message", id: "free", message: { role: "assistant", content: [], usage: piUsage(0, 0, 0), stopReason: "stop" } });
			expect(free.bySource.main).toMatchObject({ known: 1, unknown: 0 });
			expect(free.complete).toBe(true);
		});
	});

	it("takes a stop followed by another decision with no message between as overridden", () => {
		const r = report(warming({ piAction: "stop", action: "stop", requestsSeen: true }), warming({ piAction: "stop", action: "stop", requestsSeen: true }));
		expect(r.skipped).toBe(1);
		expect(r.bySource["native-warm"]).toMatchObject({ unknown: 1 });
		expect(r.complete).toBe(false);
	});

	it("counts compactions and branch summaries by their usage, and unknown without it", () => {
		const known = report(compaction({ usage: piUsage(3) }), branchSummary(piUsage(5)));
		expect(known.bySource.compaction).toMatchObject({ requests: 1, cost: 3 });
		expect(known.bySource["branch-summary"]).toMatchObject({ requests: 1, cost: 5 });
		expect(known.piCounted.cost).toBe(8);

		const unknown = report(compaction(), compaction({ fromHook: true }), branchSummary());
		expect(unknown.unknown).toBe(3);
		expect(unknown.complete).toBe(false);
	});

	it("counts our own cut as no request: it is built without a model", () => {
		const r = report(compaction({ ours: true }));
		expect(r.requests).toBe(0);
		expect(r.complete).toBe(true);
	});

	it("counts the usage a tool result carries as tool-side usage", () => {
		const r = report(toolCall("t1", "workflow", {}), toolResult("t1", "workflow", undefined, piUsage(7)));
		expect(r.bySource.tool).toMatchObject({ requests: 1, cost: 7 });
		expect(r.piCounted.cost).toBe(7);
	});

	it("sums tokens beside the cost", () => {
		const r = report(assistant(1, { input: 100, cacheRead: 900, output: 10 }), attempt("a1", "stored", totals(1, 5, 7, 11, 13)));
		expect(r.tokens).toEqual({ input: 105, output: 17, cacheRead: 911, cacheWrite: 13, cost: 2 });
	});
});

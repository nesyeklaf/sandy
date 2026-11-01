import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { compareShapes, hash53, requestShape, type RequestShape } from "../src/core/continuity.ts";
import {
	answerUsage,
	classifyRequest,
	ConversationLedger,
	cutHead,
	isRefused,
	Ledger,
	Ledgers,
	RequestTracker,
} from "../src/core/ledger.ts";

const payload = (messages: unknown[], system = "sys") => ({
	model: "m",
	system,
	stream: true,
	max_tokens: 100,
	messages,
});

describe("hashed shapes", () => {
	it("hashes each payload item to one safe integer, the same for the same content", () => {
		const shape = requestShape(
			payload([
				{ role: "user", content: "a secret" },
				{ role: "assistant", content: "b" },
			]),
		);
		assert.ok(shape);
		assert.equal(shape.items.length, 2);
		for (const hash of [shape.head, ...shape.items]) {
			assert.ok(Number.isSafeInteger(hash) && hash >= 0, `${hash} is a 53-bit hash`);
		}
		const reordered = requestShape({
			messages: [{ content: "a secret", role: "user" }],
			max_tokens: 1,
			system: "sys",
			model: "m",
		});
		assert.equal(reordered?.items[0], shape.items[0]);
		assert.equal(reordered?.head, shape.head);
		assert.doesNotMatch(JSON.stringify(shape), /secret/);
	});

	it("gives different text different hashes", () => {
		const hashes = new Set(Array.from({ length: 10_000 }, (_, index) => hash53(`message ${index}`)));
		assert.equal(hashes.size, 10_000);
		assert.notEqual(hash53("ab"), hash53("ba"));
	});

	it("treats appended messages and moved cache markers as a continuation", () => {
		const first = requestShape(
			payload([{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }]),
		);
		const second = requestShape({
			...payload([
				{ role: "user", content: [{ type: "text", text: "hi" }] },
				{ role: "assistant", content: "hello" },
			]),
			max_tokens: 999,
		});
		assert.ok(first && second);
		assert.deepEqual(compareShapes(undefined, first), { kind: "first" });
		assert.deepEqual(compareShapes(first, second), { kind: "continued" });
	});

	it("reads a string content and a lone text block as the same message", () => {
		// pi-ai sends the message that carries the cache marker as a text block, and the same message later as a string.
		const marked = requestShape(
			payload([{ role: "user", content: [{ type: "text", text: "one", cache_control: { type: "ephemeral" } }] }]),
		);
		const plain = requestShape(
			payload([
				{ role: "user", content: "one" },
				{ role: "assistant", content: [{ type: "text", text: "a" }] },
			]),
		);
		assert.ok(marked && plain);
		assert.deepEqual(compareShapes(marked, plain), { kind: "continued" });
		const other = requestShape(payload([{ role: "user", content: [{ type: "text", text: "two" }] }]));
		assert.ok(other);
		assert.deepEqual(compareShapes(marked, other), { kind: "broken", at: 0 });
	});

	it("locates a break in the history or the head", () => {
		const base = requestShape(
			payload([
				{ role: "user", content: "a" },
				{ role: "user", content: "b" },
			]),
		);
		const edited = requestShape(
			payload([
				{ role: "user", content: "a" },
				{ role: "user", content: "B" },
			]),
		);
		const system = requestShape(payload([{ role: "user", content: "a" }], "other"));
		assert.ok(base && edited && system);
		assert.deepEqual(compareShapes(base, edited), { kind: "broken", at: 1 });
		assert.deepEqual(compareShapes(base, system), { kind: "broken", at: "head" });
		assert.equal(requestShape({ no: "messages" }), undefined);
	});
});

describe("request tracker", () => {
	const shape = (...items: number[]): RequestShape => ({ head: 1, items });

	it("compares with the last accepted request, not with a refused one", () => {
		const tracker = new RequestTracker();
		tracker.begin(shape(1), "m");
		assert.equal(tracker.settle(false, undefined)?.requestClass, "first");
		tracker.begin(shape(1, 9), "m");
		assert.equal(tracker.settle(true, undefined)?.requestClass, "rejected");
		tracker.begin(shape(1, 2, 3), "m");
		assert.equal(tracker.settle(false, undefined)?.requestClass, "continued");
	});

	it("judges nothing when no payload was seen or the request was abandoned", () => {
		assert.equal(new RequestTracker().settle(false, undefined), undefined);
		const tracker = new RequestTracker();
		tracker.begin(shape(1), "m");
		tracker.abandon();
		assert.equal(tracker.settle(false, undefined), undefined);
	});

	it("classifies requests for the ledger", () => {
		assert.equal(classifyRequest({ kind: "broken", at: 0 }, "watermark"), "planned");
		assert.equal(classifyRequest({ kind: "broken", at: 3 }, undefined), "unplanned");
		assert.equal(classifyRequest({ kind: "broken", at: "head" }, undefined), "external");
		assert.equal(classifyRequest({ kind: "continued" }, "watermark"), "continued");
		const ledger = new Ledger();
		ledger.record("continued");
		ledger.record("planned", "cold");
		ledger.addUsage({ input: 10, cacheRead: 90, cacheWrite: 0 });
		assert.equal(ledger.requests, 2);
		assert.match(ledger.report().join("\n"), /planned 1 \[cold 1\].*\n.*0\.0%.*\n.*90\.0%/);
	});
});

describe("answers", () => {
	const usage = (input: number) => ({ input, cacheRead: 0, cacheWrite: 0, output: 1, cost: { total: 0.5 } });

	it("counts an error or abort with an empty prompt as refused", () => {
		assert.equal(isRefused({ stopReason: "error", usage: usage(0) }), true);
		assert.equal(isRefused({ stopReason: "aborted" }), true);
		assert.equal(isRefused({ stopReason: "error", usage: usage(5) }), false);
		assert.equal(isRefused({ stopReason: "stop", usage: usage(0) }), false);
		assert.deepEqual(answerUsage({ usage: usage(5) }), { input: 5, cacheRead: 0, cacheWrite: 0, output: 1, cost: 0.5 });
	});
});

describe("conversation ledger", () => {
	const system = { role: "system", content: "prompt" };
	const cut = (reason: string) => ({ role: "user", content: `<summary>\n<sandy-context reason="${reason}">\nkept` });
	const user = (text: string) => ({ role: "user", content: text });
	const accepted = { stopReason: "stop", usage: { input: 1 } };
	const refused = { stopReason: "error", usage: { input: 0 } };
	const shape = (...items: number[]): RequestShape => ({ head: 1, items });

	it("finds the cut at the head of a request and the reason in its tag", () => {
		assert.deepEqual(cutHead([system, cut("watermark"), user("a")])?.reason, "watermark");
		assert.equal(cutHead([system, user("a"), cut("watermark")]), undefined);
		assert.equal(cutHead([system, user("a")]), undefined);
		assert.notEqual(cutHead([cut("cold")])?.hash, cutHead([cut("model")])?.hash);
	});

	it("plans a break for a cut the last accepted request did not carry, until a request carrying it is accepted", () => {
		const ledger = new ConversationLedger();
		const head = cutHead([cut("watermark")]);
		ledger.begin(shape(1, 2), "m", undefined);
		assert.equal(ledger.settle(accepted)?.requestClass, "first");
		ledger.begin(shape(7), "m", head);
		assert.equal(ledger.settle(refused)?.requestClass, "rejected");
		ledger.begin(shape(7, 8), "m", head);
		const planned = ledger.settle(accepted);
		assert.equal(planned?.requestClass, "planned");
		assert.equal(planned?.reason, "watermark");
		// The same cut again: a break now is not planned.
		ledger.begin(shape(7, 9), "m", head);
		assert.equal(ledger.settle(accepted)?.requestClass, "unplanned");
		assert.deepEqual(ledger.ledger.counts, {
			first: 1,
			continued: 0,
			planned: 1,
			external: 0,
			unplanned: 1,
			rejected: 1,
		});
		ledger.begin(shape(1), "m", undefined);
		ledger.abandon();
		assert.equal(ledger.settle(accepted), undefined);
	});

	it("keeps at most its limit of conversations, evicting the least recently used", () => {
		const ledgers = new Ledgers(2);
		const a = ledgers.get(1);
		ledgers.get(2);
		assert.equal(ledgers.get(1), a);
		ledgers.get(3);
		assert.equal(ledgers.size, 2);
		assert.equal(ledgers.get(1), a);
		const fresh = ledgers.get(2);
		fresh.begin(shape(1), "m", undefined);
		assert.equal(fresh.settle(accepted)?.requestClass, "first");
		assert.equal(ledgers.size, 2);
	});
});

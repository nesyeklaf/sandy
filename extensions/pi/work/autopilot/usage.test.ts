import assert from "node:assert/strict";
import { test } from "node:test";
import { LEASE_MARKER, LEASE_METERED, latestMarker, unreportedTickets, usageForTicket, type SessionEntryLike } from "./usage.ts";

let id = 0;
const marker = (ticket: string): SessionEntryLike => ({ type: "custom", id: String(++id), customType: LEASE_MARKER, data: { ticket } });
const assistant = (input: number, output: number, extra: { cacheRead?: number; cacheWrite?: number } = {}): SessionEntryLike => ({
	type: "message",
	id: String(++id),
	message: { role: "assistant", usage: { input, output, cacheRead: extra.cacheRead ?? 0, cacheWrite: extra.cacheWrite ?? 0, totalTokens: input + output + (extra.cacheRead ?? 0) + (extra.cacheWrite ?? 0) } },
});
const endMarker = (): SessionEntryLike => ({ type: "custom", id: String(++id), customType: LEASE_MARKER, data: { ticket: null } });
const user: SessionEntryLike = { type: "message", id: "u", message: { role: "user" } };

test("a lease's usage sums the assistant messages after its marker until the next marker, over every segment it owns", () => {
	const entries = [assistant(100, 1), marker("r1.1"), user, assistant(10, 2, { cacheRead: 5 }), marker("r1.2"), assistant(7, 7), marker("r1.1"), assistant(1, 1, { cacheWrite: 3 })];
	assert.deepEqual(usageForTicket(entries, "r1.1"), { input: 11, output: 3, cacheRead: 5, cacheWrite: 3, total: 22, messages: 2 });
	assert.deepEqual(usageForTicket(entries, "r1.2"), { input: 7, output: 7, cacheRead: 0, cacheWrite: 0, total: 14, messages: 1 });
});

test("no marker for the ticket is unknown (null), a marker without messages is zero", () => {
	assert.equal(usageForTicket([assistant(1, 1)], "r1.1"), null);
	assert.deepEqual(usageForTicket([marker("r1.1")], "r1.1"), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, messages: 0 });
});

test("an assistant message without usage makes the lease's usage unknown, never a smaller number", () => {
	const entries = [marker("r1.1"), assistant(1, 1), { type: "message", id: "x", message: { role: "assistant" } }];
	assert.equal(usageForTicket(entries, "r1.1"), null);
});

test("nested model work in a tool result and usage entries count for the lease, without counting as messages", () => {
	const entries: SessionEntryLike[] = [
		marker("r1.1"),
		{ type: "message", id: "t", message: { role: "toolResult", usage: { input: 4, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 8 } } },
		{ type: "message", id: "t2", message: { role: "toolResult" } },
		{ type: "usage", id: "w", usage: { input: 0, output: 0, cacheRead: 50, cacheWrite: 0, totalTokens: 50 } },
	];
	assert.deepEqual(usageForTicket(entries, "r1.1"), { input: 4, output: 4, cacheRead: 50, cacheWrite: 0, total: 58, messages: 0 });
});

test("an end marker ends attribution: later entries belong to no lease until the next marker", () => {
	const entries = [marker("r1.1"), assistant(10, 2), endMarker(), assistant(500, 500), marker("r1.1"), assistant(1, 1)];
	assert.deepEqual(usageForTicket(entries, "r1.1"), { input: 11, output: 3, cacheRead: 0, cacheWrite: 0, total: 14, messages: 2 });
	assert.deepEqual(usageForTicket([marker("r1.1"), assistant(10, 2), endMarker(), assistant(500, 500)], "r1.1"), { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12, messages: 1 });
});

test("latestMarker is null after an end marker", () => {
	assert.equal(latestMarker([marker("r1.1"), assistant(1, 1), endMarker()]), null);
	assert.equal(latestMarker([marker("r1.1"), endMarker(), marker("r1.2")]), "r1.2");
});

test("latestMarker names the lease the session acts for now", () => {
	assert.equal(latestMarker([assistant(1, 1)]), null);
	assert.equal(latestMarker([marker("r1.1"), assistant(1, 1), marker("r1.2"), user]), "r1.2");
});

test("unreportedTickets: a ticket is reported once an end marker follows its segment or a metered record names it", () => {
	const metered = (ticket: string): SessionEntryLike => ({ type: "custom", id: String(++id), customType: LEASE_METERED, data: { ticket } });
	assert.deepEqual(unreportedTickets([]), []);
	assert.deepEqual(unreportedTickets([marker("a"), assistant(1, 1), marker("b")]), ["a", "b"]);
	assert.deepEqual(unreportedTickets([marker("a"), endMarker(), marker("b")]), ["b"], "an end marker reported the lease before it");
	assert.deepEqual(unreportedTickets([marker("a"), marker("b"), metered("a")]), ["b"], "a metered record reports an older lease and leaves the newer one");
	assert.deepEqual(unreportedTickets([marker("a"), marker("b"), metered("a"), endMarker()]), [], "the end marker after the newest marker");
	assert.deepEqual(unreportedTickets([marker("a"), endMarker(), endMarker()]), []);
});

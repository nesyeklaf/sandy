import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveConfig } from "../src/core/config.ts";
import { evidenceBudget, HISTORIAN_SYSTEM_PROMPT, historianPrompt, REFERENCE_MIN_CHARS, selectEvidence, validateCompletion } from "../src/core/historian.ts";
import { forkTurn } from "../src/pi/historian.ts";
import type { SummarizeRequest } from "../src/historian/run.ts";
import { sessionLog } from "./support/session-log.ts";

/*
 * A fork continues the main model's last request, which still holds most of the entries the summary covers: the fork's
 * summary turn names those by id and opening instead of paying for them again as fresh input.
 */

const config = resolveConfig({
	keepRecentTokens: 1_000,
	maskedTokens: 500,
	pinnedUserTokens: 1_000,
	historian: { chunkMinTokens: 100, chunkMaxTokens: 6_000 },
});

/** Text of numbered lines, so no stretch of one entry repeats inside another. */
const lines = (label: string, chars: number) =>
	["FACT " + label + " holds.", ...Array.from({ length: Math.ceil(chars / 40) }, (_, i) => `line ${i} of ${label}, words ${(i * 7919) % 1000}`)].join("\n");

/** A prompt and its long answer. */
function essay(log: ReturnType<typeof sessionLog>, label: string, chars: number) {
	log.user("Please explain " + label + ".");
	return log.answer(lines(label, chars));
}

/** History the next cut keeps, so the entries before it can be summarized. */
function tail(log: ReturnType<typeof sessionLog>) {
	for (const label of ["a", "b", "c", "d", "e", "f"]) essay(log, label, 1_200);
}

function session() {
	const log = sessionLog();
	const held = essay(log, "held", 3_000);
	const gone = essay(log, "gone", 3_000);
	log.user("Please read the report.");
	log.call("c-read", "read", { path: "report.txt" });
	const read = log.result("c-read", "read", lines("read", 3_000));
	log.answer("Read it.");
	tail(log);
	const history = log.tape().history();
	const work = selectEvidence(history, evidenceBudget(config, false));
	assert.ok(work, "the fixture has no work");
	const text = (id: string) => history.entries.find((entry) => entry.id === id)?.text as string;
	const request: SummarizeRequest = {
		system: HISTORIAN_SYSTEM_PROMPT,
		prompt: historianPrompt(work),
		referencing: (above) => historianPrompt(work, above),
		maxTokens: 1_000,
		signal: new AbortController().signal,
	};
	return { work, request, held, gone, read, text };
}

/** A captured main request as a provider payload: the given texts as messages, JSON-encoded like the wire body. */
function capture(...texts: string[]) {
	return { json: JSON.stringify({ model: "m", messages: texts.map((text) => ({ role: "assistant", content: [{ type: "text", text }] })) }) };
}

const entryOf = (turn: string, id: string) => new RegExp(`<entry id="${id}"[^>]*>\\n[\\s\\S]*?\\n</entry>`).exec(turn)?.[0] ?? "";

describe("the fork's summary turn over entries its request already holds", () => {
	it("names a long entry the request holds by its id and opening, and shows the others whole", () => {
		const { request, held, gone, read, text } = session();
		const turn = forkTurn(request, capture(text(held), text(read), "an unrelated message"));
		const named = entryOf(turn, held);
		assert.match(named, /shown="above"/);
		assert.ok(named.includes("FACT held holds."), "the opening lets the model find the message above");
		assert.ok(named.length < 600, "the named entry is not shown again: " + named.length);
		assert.match(entryOf(turn, read), /shown="above"/, "a clipped tool output the request holds whole is named too");
		const shown = entryOf(turn, gone);
		assert.doesNotMatch(shown, /shown="above"/, "an entry the request no longer holds is shown");
		assert.ok(shown.includes(text(gone)), "and shown whole");
		const saved = forkTurn(request).length - turn.length;
		assert.ok(saved > text(held).length + 2_000 - 2 * 600, "the turn is smaller by what it names: " + saved);
	});

	it("shows an entry the request holds only in part, and every entry when no capture is given", () => {
		const { request, held, text } = session();
		// A masked copy keeps the opening, not the end.
		const partial = forkTurn(request, capture(text(held).slice(0, 1_500)));
		assert.doesNotMatch(entryOf(partial, held), /shown="above"/);
		assert.equal(forkTurn(request), forkTurn({ ...request, referencing: undefined }, capture(text(held))));
		assert.doesNotMatch(forkTurn(request), /<entry [^>]*shown="above"/);
	});

	it("never names a short entry or a part of a long one", () => {
		const log = sessionLog();
		const long = essay(log, "long", 40_000);
		tail(log);
		const history = log.tape().history();
		const work = selectEvidence(history, evidenceBudget(config, false));
		assert.ok(work);
		const span = work.spans.find((one) => one.entryId === long);
		assert.ok(span && span.to < span.total, "the long answer is shown in spans");
		assert.equal(span.probes, undefined, "a span of part of an entry is never named");
		assert.ok(work.spans.every((one) => !one.probes || one.text.length >= REFERENCE_MIN_CHARS));
		const everything = () => true;
		assert.doesNotMatch(historianPrompt(work, everything), /<entry [^>]*shown="above"/);
	});

	it("lets an answer cite a named entry", () => {
		const { work, held } = session();
		const result = validateCompletion({ text: "## Facts and findings\n- FACT held holds (#" + held + ")", stopReason: "stop", toolCalls: 0 }, work);
		assert.equal(result.ok, true, JSON.stringify(result));
	});
});

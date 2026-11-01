import { describe, expect, it } from "vitest";
import { redact, renderDelta, sliceAfter } from "../src/core/delta.ts";
import type { Msg } from "../src/core/types.ts";

const lim = { toolResultMaxChars: 100, textMaxChars: 200 };
const msgs: Msg[] = [
	{ role: "user", content: "hi" },
	{ role: "assistant", content: [{ type: "text", text: "ok" }, { type: "toolCall", id: "1", name: "bash", arguments: { cmd: "ls" } }] },
	{ role: "toolResult", toolCallId: "1", toolName: "bash", content: [{ type: "text", text: "x".repeat(500) }] },
];

describe("delta", () => {
	it("is deterministic and starts with the fixed heading", () => {
		expect(renderDelta(msgs, lim)).toBe(renderDelta(msgs, lim));
		expect(renderDelta(msgs, lim).startsWith("### Session update\n")).toBe(true);
	});
	it("clips long tool results in the middle", () => {
		expect(renderDelta(msgs, lim)).toContain("chars cut");
	});
	it("redacts secrets", () => {
		expect(redact("token=abcdef123456 und sk-abcdefghijklmnopqrstuv")).not.toMatch(/abcdef123456|sk-abcdefghijklmnop/);
	});
	it("slices after the cursor, and falls back to a short tail on an unknown cursor", () => {
		const e = Array.from({ length: 30 }, (_, i) => ({ id: String(i), message: { role: "user", content: String(i) } as Msg }));
		expect(sliceAfter(e, "27").messages).toHaveLength(2);
		expect(sliceAfter(e, "gone").messages).toHaveLength(12);
		expect(sliceAfter(e, undefined).lastId).toBe("29");
	});
});

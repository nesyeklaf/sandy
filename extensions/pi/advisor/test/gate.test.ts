import { describe, expect, it } from "vitest";
import { gate } from "../src/core/gate.ts";
import type { Suspicion } from "../src/core/rules.ts";

const answer = "Ich habe es gebaut. Alle Tests sind grün. Fertig.";
const s: Suspicion[] = [{ rule: "tests_pass", quote: "Alle Tests sind grün.", why: "kein Lauf", kind: "unbelegt" }];
const base = { answer, suspicions: s, delta: "### Session update", timeoutMs: 50, onTimeout: "release" as const };

describe("gate", () => {
	it("releases without calling the advisor when no rule hit", async () => {
		let called = false;
		const r = await gate({ ...base, suspicions: [], ask: async () => ((called = true), "{}") });
		expect(called).toBe(false);
		expect(r).toMatchObject({ text: answer, changed: false, outcome: "released" });
	});
	it("rewrites an open claim in place and keeps the rest", async () => {
		const r = await gate({ ...base, ask: async () => '{"findings":[{"quote":"Alle Tests sind grün.","verdict":"unbelegt","why":"kein Lauf","fix":"Tests habe ich nicht ausgeführt."}]}' });
		expect(r.outcome).toBe("checked");
		expect(r.text).toBe("Ich habe es gebaut. Tests habe ich nicht ausgeführt. Fertig.");
		expect(r.text).not.toContain("Advisor-Prüfung");
	});
	it("annotates but keeps the whole answer in annotate mode", async () => {
		const r = await gate({ ...base, mode: "annotate", ask: async () => '{"findings":[{"quote":"Alle Tests sind grün.","verdict":"unbelegt","why":"kein Lauf"}]}' });
		expect(r.outcome).toBe("checked");
		expect(r.text).toContain(answer.replace("grün.", "grün. ⚠1"));
	});
	it("fails open when the advisor is slow", async () => {
		const r = await gate({ ...base, ask: (_p, sig) => new Promise((res) => sig.addEventListener("abort", () => res(undefined))) });
		expect(r).toMatchObject({ text: answer, changed: false, outcome: "unchecked" });
	});
	it("can mark rule hits when the advisor is slow", async () => {
		const r = await gate({ ...base, onTimeout: "annotate-rules", ask: async () => undefined });
		expect(r.changed).toBe(true);
		expect(r.text.startsWith(answer.replace("grün.", "grün. ⚠1").slice(0, 20))).toBe(true);
	});
	it("fails open on an unparsable reply", async () => {
		const r = await gate({ ...base, ask: async () => "ich bin prosa" });
		expect(r.changed).toBe(false);
	});
});

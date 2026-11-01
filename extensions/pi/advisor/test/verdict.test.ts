import { describe, expect, it } from "vitest";
import { annotate, parseReview, rewrite } from "../src/core/verdict.ts";

const answer = "Ich habe den Fix gebaut. Alle Tests sind grün. Danach habe ich gepusht.";

describe("parseReview", () => {
	it("reads JSON out of prose and fences", () => {
		const r = parseReview('Hier:\n```json\n{"findings":[{"quote":"Alle Tests sind grün.","verdict":"unbelegt","why":"kein Lauf"}],"proposals":[]}\n```', answer);
		expect(r?.findings).toHaveLength(1);
	});
	it("drops findings whose quote is not in the answer", () => {
		const r = parseReview('{"findings":[{"quote":"erfunden","verdict":"widerlegt","why":"x"}]}', answer);
		expect(r?.findings).toEqual([]);
	});
	it("returns undefined for garbage", () => {
		expect(parseReview("kein json", answer)).toBeUndefined();
		expect(parseReview("{kaputt", answer)).toBeUndefined();
	});
	it("validates proposals", () => {
		const r = parseReview('{"proposals":[{"kind":"idea","title":"A","description":"B"},{"kind":"x","title":"A","description":"B"},{"kind":"intent","title":"","description":"B"}]}');
		expect(r?.proposals).toHaveLength(1);
	});
	it("keeps braces inside strings", () => {
		const r = parseReview('{"note":"nutze } und { vorsichtig"}');
		expect(r?.note).toBe("nutze } und { vorsichtig");
	});
});

describe("rewrite", () => {
	const f = (quote: string, fix?: string) => ({ quote, verdict: "unbelegt" as const, why: "x", ...(fix !== undefined && { fix }) });
	it("replaces the quote with its fix and leaves the rest byte for byte", () => {
		expect(rewrite(answer, [f("Alle Tests sind grün.", "Tests habe ich nicht ausgeführt.")])).toBe("Ich habe den Fix gebaut. Tests habe ich nicht ausgeführt. Danach habe ich gepusht.");
	});
	it("drops a quote with an empty fix without leaving a gap", () => {
		expect(rewrite(answer, [f("Alle Tests sind grün.", "")])).toBe("Ich habe den Fix gebaut. Danach habe ich gepusht.");
	});
	it("flags inline when there is no fix, and ignores quotes it cannot place", () => {
		expect(rewrite(answer, [f("Danach habe ich gepusht."), f("nicht da", "y")])).toBe("Ich habe den Fix gebaut. Alle Tests sind grün. Danach habe ich gepusht. (nicht belegt)");
	});
	it("never touches a belegt claim", () => {
		expect(rewrite(answer, [{ quote: "Ich habe den Fix gebaut.", verdict: "belegt", why: "edit", fix: "weg" }])).toBe(answer);
	});
	it("reads fix from the reply", () => {
		expect(parseReview('{"findings":[{"quote":"Alle Tests sind grün.","verdict":"unbelegt","why":"x","fix":" aus "}]}', answer)?.findings[0]?.fix).toBe("aus");
	});
});

describe("annotate", () => {
	it("keeps the original text byte for byte and appends marks", () => {
		const out = annotate(answer, [{ quote: "Alle Tests sind grün.", verdict: "unbelegt", why: "kein Lauf" }]);
		expect(out.replace(/ ⚠1/, "").startsWith(answer)).toBe(true);
		expect(out).toContain("Alle Tests sind grün. ⚠1");
		expect(out).toContain("⚠1 unbelegt: kein Lauf");
	});
	it("leaves a fully backed answer untouched", () => {
		expect(annotate(answer, [{ quote: "Ich habe den Fix gebaut.", verdict: "belegt", why: "edit" }])).toBe(answer);
	});
	it("never loses text when a quote cannot be placed", () => {
		const out = annotate(answer, [{ quote: "nicht da", verdict: "widerlegt", why: "x" }]);
		expect(out.startsWith(answer)).toBe(true);
	});
});

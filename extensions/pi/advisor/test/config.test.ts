import { describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig } from "../src/core/config.ts";

const files = (m: Record<string, string>) => (p: string) => {
	if (p in m) return m[p]!;
	throw new Error("ENOENT");
};

describe("config", () => {
	it("falls back to defaults when no file exists", () => {
		expect(loadConfig(["a"], files({}))).toEqual({ config: DEFAULTS, errors: [] });
	});
	it("merges deeply, later file wins", () => {
		const r = loadConfig(["a", "b"], files({ a: '{"model":{"id":"x"},"gate":{"timeoutMs":1}}', b: '{"gate":{"timeoutMs":2}}' }));
		expect(r.config.model).toEqual({ ...DEFAULTS.model, id: "x" });
		expect(r.config.gate.timeoutMs).toBe(2);
		expect(r.errors).toEqual([]);
	});
	it("reports unknown keys and wrong types but keeps the rest", () => {
		const r = loadConfig(["a"], files({ a: '{"gate":{"timeoutMs":"fast"},"bogus":1,"review":{"everyTurns":9}}' }));
		expect(r.config.gate.timeoutMs).toBe(DEFAULTS.gate.timeoutMs);
		expect(r.config.review.everyTurns).toBe(9);
		expect(r.errors).toHaveLength(2);
	});
	it("skips a broken file", () => {
		const r = loadConfig(["a"], files({ a: "{nope" }));
		expect(r.config).toEqual(DEFAULTS);
		expect(r.errors).toHaveLength(1);
	});
	it("allows custom gate rule switches", () => {
		expect(loadConfig(["a"], files({ a: '{"gate":{"rules":{"tests_pass":false}}}' })).config.gate.rules.tests_pass).toBe(false);
	});
});

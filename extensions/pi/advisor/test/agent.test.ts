import { describe, expect, it } from "vitest";
import { emptyStats, type Asker } from "../src/core/asker.ts";
import { DEFAULTS, loadConfig } from "../src/core/config.ts";
import { Advisor, type Entry } from "../src/core/runtime.ts";
import { loadContext } from "../src/pi/contextKit.ts";

const long = "Ich habe alles gebaut. Alle Tests sind grün und der Build ist sauber. " + "x".repeat(200);
const entries: Entry[] = [{ id: "1", message: { role: "user", content: "bau das" } }];

function fakeAsker(answer: string) {
	const asked: string[] = [];
	const asker: Asker = {
		stats: emptyStats(),
		async ask(text) {
			asked.push(text);
			return answer;
		},
		reset() {},
		size: 0,
	};
	return { asker, asked };
}

describe("Advisor with an injected Asker", () => {
	it("asks the asker instead of the bare model call", async () => {
		const { asker, asked } = fakeAsker("{}");
		let bare = 0;
		const a = new Advisor({ config: DEFAULTS, asker, complete: async () => (bare++, undefined as never), exec: async () => ({ code: 0, stdout: "", stderr: "" }), sandy: "sandy", sessionId: "s", entries: () => entries });
		const r = await a.gateFinal(long);
		expect(bare).toBe(0);
		expect(asked).toHaveLength(1);
		expect(r.outcome).toBe("checked");
	});
	it("fails open when the asker has no answer", async () => {
		const asker: Asker = { stats: emptyStats(), ask: async () => undefined, reset() {}, size: 0 };
		const a = new Advisor({ config: DEFAULTS, asker, complete: async () => undefined as never, exec: async () => ({ code: 0, stdout: "", stderr: "" }), sandy: "sandy", sessionId: "s", entries: () => entries });
		const r = await a.gateFinal(long);
		expect(r.text).toBe(long);
		expect(r.outcome).toBe("unchecked");
	});
});

describe("agent config", () => {
	it("merges the agent block and replaces the tools list instead of appending", () => {
		const r = loadConfig(["a"], () => '{"agent":{"tools":["read"],"maxToolCalls":2,"promote":{"id":"big"}}}');
		expect(r.errors).toEqual([]);
		expect(r.config.agent.tools).toEqual(["read"]);
		expect(r.config.agent.maxToolCalls).toBe(2);
		expect(r.config.agent.promote.id).toBe("big");
		expect(r.config.agent.promote.atTokens).toBe(DEFAULTS.agent.promote.atTokens);
		expect(r.config.agent.enabled).toBe(true);
	});
	it("reports a wrong type and keeps the default", () => {
		const r = loadConfig(["a"], () => '{"agent":{"maxToolCalls":"many"}}');
		expect(r.config.agent.maxToolCalls).toBe(DEFAULTS.agent.maxToolCalls);
		expect(r.errors.length).toBeGreaterThan(0);
	});
});

describe("contextKit", () => {
	it("returns undefined when pi/context is not there", async () => {
		expect(await loadContext("/nonexistent/context")).toBeUndefined();
	});
	it("loads the sibling pi/context unit in the monorepo", async () => {
		const kit = await loadContext();
		if (!kit) return; // checkout without the sibling unit
		expect(typeof kit.readHistory).toBe("function");
		expect(typeof kit.createContextExtension).toBe("function");
	});
});

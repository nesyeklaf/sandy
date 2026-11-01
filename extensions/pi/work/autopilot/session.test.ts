import assert from "node:assert/strict";
import { test } from "node:test";
import { check, installSession, submitted } from "./session.ts";

const schema = { type: "object", required: ["result"], properties: { result: { type: "string" } } };

test("an object submitted as a JSON string is parsed and passes the object schema", () => {
	const value = submitted('{"result":"a CLI that prints hello"}', schema);
	assert.deepEqual(value, { result: "a CLI that prints hello" });
	assert.equal(check(value, schema), undefined);
});

test("a string schema keeps the string, even one that looks like JSON", () => {
	assert.equal(submitted('{"a":1}', { type: "string" }), '{"a":1}');
});

test("a string that is not JSON stays a string and is rejected by an object schema", () => {
	const value = submitted("not json", schema);
	assert.equal(check(value, schema), "value must be object, got string");
});

test("a real object passes through unchanged", () => {
	const object = { result: "x" };
	assert.equal(submitted(object, schema), object);
});

/** pi and ctx as session.ts uses them; a test ends turns itself (endTurn) and sees pi aborts (aborts). */
function fakePi() {
	const handlers: Record<string, ((event: any) => unknown)[]> = {};
	// pi activates an extension tool when it is registered.
	const state = { active: ["read", "bash"], prompts: [] as string[], aborts: 0, loadouts: [] as unknown[], sets: [] as string[], tools: {} as Record<string, any> };
	const pi = {
		registerTool: (tool: any) => {
			state.tools[tool.name] = tool;
			state.active.push(tool.name);
		},
		on: (name: string, handler: (event: any) => unknown) => void (handlers[name] ??= []).push(handler),
		getActiveTools: () => [...state.active],
		setActiveTools: (tools: string[]) => void (state.sets.push("setActiveTools"), (state.active = [...tools])),
		getThinkingLevel: () => "low",
		setThinkingLevel: () => void state.sets.push("setThinkingLevel"),
		setModel: async () => (state.sets.push("setModel"), true),
		events: { emit: (_name: string, payload: unknown) => void state.loadouts.push(payload) },
		sendUserMessage: (prompt: string) => void state.prompts.push(prompt),
		exec: async () => ({ code: 0, stdout: "", stderr: "" }),
	};
	const ctx = { isIdle: () => true, waitForIdle: async () => {}, model: { provider: "anthropic", id: "claude-x" }, abort: () => void state.aborts++ };
	const endTurn = (messages: unknown[] = []) => handlers.agent_end?.forEach((h) => h({ messages }));
	const fire = (name: string, event: unknown = {}) => (handlers[name] ?? []).map((h) => h(event));
	/** The tool_call hook's verdict on one call, as pi asks it before running the tool (also nested calls). */
	const toolCall = (toolName: string) => fire("tool_call", { toolName, input: {} }).find(Boolean) as { block?: boolean; reason?: string } | undefined;
	return { pi, ctx, state, endTurn, fire, toolCall };
}

const flush = async () => {
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("a session bound to an ended lease refuses a step before it prompts or changes the loadout", async () => {
	const fake = fakePi();
	const lost = new AbortController();
	lost.abort(new Error("the lease ended (forced)"));
	const session = installSession(fake.pi, () => null)(fake.ctx, { signal: lost.signal });
	const outcome = session.step({ say: "work", tools: ["read"] }).then(() => "resolved", (error: Error) => error.message);
	await flush();
	assert.deepEqual(fake.state.prompts, [], "no prompt is sent for a lost lease");
	assert.equal(await outcome, "the lease ended (forced)");
	assert.deepEqual(fake.state.active, ["read", "bash", "autopilot_submit"]);
});

test("a force during a step aborts pi's turn, restores the loadout and sends no schema reminder", async () => {
	const fake = fakePi();
	const lease = new AbortController();
	const session = installSession(fake.pi, () => null)(fake.ctx, { signal: lease.signal });
	const outcome = session.step({ say: "work", tools: ["read"], schema: { type: "string" } }).then(() => "resolved", (error: Error) => error.message);
	await flush();
	assert.equal(fake.state.prompts.length, 1, "the turn is running");
	lease.abort(new Error("the lease ended (forced)")); // the heartbeat saw the owner's force
	await flush();
	assert.equal(fake.state.aborts, 1, "the running turn is aborted in pi");
	assert.equal(await outcome, "the lease ended (forced)");
	assert.deepEqual(fake.state.active, ["read", "bash", "autopilot_submit"], "the tools never changed");
	fake.endTurn(); // the aborted run's agent_end arrives late
	await flush();
	assert.equal(fake.state.prompts.length, 1, "no reminder turn after the abort");
});

test("an unbound session (plain /autopilot) steps as before", async () => {
	const fake = fakePi();
	const session = installSession(fake.pi, () => null)(fake.ctx);
	const outcome = session.step({ say: "work" });
	await flush();
	fake.endTurn([{ role: "assistant", content: "done" }]);
	assert.equal((await outcome).text, "done");
});

test("a step never changes the request prefix: no tool, thinking or model change during or after it, the same active tools", async () => {
	const fake = fakePi();
	const session = installSession(fake.pi, () => null)(fake.ctx);
	fake.fire("session_start");
	const before = fake.pi.getActiveTools();
	const outcome = session.step({ say: "work", tools: ["read"], schema: { type: "string" }, model: "anthropic/claude-x", thinking: "low" });
	await flush();
	assert.deepEqual(fake.pi.getActiveTools(), before, "during the step");
	await fake.state.tools.autopilot_submit.execute("c1", { value: "x" });
	fake.endTurn();
	assert.equal((await outcome).value, "x");
	assert.deepEqual(fake.pi.getActiveTools(), before, "after the step");
	assert.deepEqual(fake.state.sets, [], "no setActiveTools, setThinkingLevel or setModel");
	assert.deepEqual(fake.state.loadouts, [], "no loadout event, so no tool owner changes the tools either");
});

test("autopilot_submit is active from session_start on and refused outside a step that asks for a value", async () => {
	const fake = fakePi();
	const session = installSession(fake.pi, () => null)(fake.ctx);
	fake.fire("session_start");
	assert.ok(fake.pi.getActiveTools().includes("autopilot_submit"));
	assert.match(fake.toolCall("autopilot_submit")?.reason ?? "", /no autopilot step asks for a value/i);
	assert.equal(fake.toolCall("autopilot_submit")?.block, true);
	const plain = session.step({ say: "work" });
	await flush();
	assert.equal(fake.toolCall("autopilot_submit")?.block, true, "a step without a schema wants no value");
	fake.endTurn();
	await plain;
	const asking = session.step({ say: "work", schema: { type: "string" } });
	await flush();
	assert.equal(fake.toolCall("autopilot_submit"), undefined, "a step with a schema lets it through");
	await fake.state.tools.autopilot_submit.execute("c1", { value: "x" });
	fake.endTurn();
	await asking;
	assert.equal(fake.toolCall("autopilot_submit")?.block, true, "and only while it runs");
});

test("a tool outside a step's list is blocked by the tool_call hook, and the step prompt names the allowed tools", async () => {
	const fake = fakePi();
	const session = installSession(fake.pi, () => null)(fake.ctx);
	const outcome = session.step({ say: "work", tools: ["read"] });
	await flush();
	assert.equal(fake.toolCall("read"), undefined);
	assert.deepEqual(fake.toolCall("bash"), { block: true, reason: "The autopilot step does not allow bash." });
	assert.match(fake.state.prompts[0]!, /Tools for this step: read\./);
	fake.endTurn();
	await outcome;
	assert.equal(fake.toolCall("bash"), undefined, "outside a step nothing is blocked");
	const none = session.step({ say: "think", tools: [] });
	await flush();
	assert.match(fake.state.prompts[1]!, /This step allows no tools\./);
	assert.equal(fake.toolCall("read")?.block, true);
	fake.endTurn();
	await none;
});

test("a step's deny list blocks those tools out of the inherited ones, also aliased, and the prompt names only them", async () => {
	const fake = fakePi();
	fake.state.active.push("TaskCreate", "mcp__x__TaskUpdate");
	const session = installSession(fake.pi, () => null)(fake.ctx);
	const outcome = session.step({ say: "work", deny: ["TaskCreate", "TaskUpdate"] });
	await flush();
	assert.equal(fake.toolCall("bash"), undefined, "inherited tools stay allowed");
	assert.equal(fake.toolCall("TaskCreate")?.block, true);
	assert.equal(fake.toolCall("mcp__x__TaskUpdate")?.block, true);
	assert.match(fake.state.prompts[0]!, /Not in this step: TaskCreate, TaskUpdate\.$/);
	fake.endTurn();
	await outcome;
	const quiet = session.step({ say: "work", deny: ["TaskGet"] });
	await flush();
	assert.equal(fake.state.prompts[1], "work", "an inactive denied tool is not named");
	fake.endTurn();
	await quiet;
});

test("an accepted autopilot_submit ends the step turn without a model reply after it; a rejected one does not", async () => {
	const fake = fakePi();
	const session = installSession(fake.pi, () => null)(fake.ctx);
	const outcome = session.step({ say: "work", schema: { type: "object", required: ["a"], properties: { a: { type: "string" } } } });
	await flush();
	const rejected = await fake.state.tools.autopilot_submit.execute("c1", { value: { b: 1 } });
	assert.equal(rejected.isError, true);
	assert.notEqual(rejected.terminate, true);
	const accepted = await fake.state.tools.autopilot_submit.execute("c2", { value: { a: "x" } });
	assert.equal(accepted.terminate, true);
	fake.endTurn();
	assert.deepEqual((await outcome).value, { a: "x" });
});

test("a step that asks for another model or thinking level is refused before it prompts; the session's own values are accepted", async () => {
	const fake = fakePi();
	const session = installSession(fake.pi, () => null)(fake.ctx);
	await assert.rejects(session.step({ say: "work", thinking: "high" }), /thinking high \(the session's is low\) would break the prompt cache; an autopilot session's model and thinking are chosen when it is launched/);
	await assert.rejects(session.step({ say: "work", model: "openai/gpt-x" }), /model openai\/gpt-x \(the session's is anthropic\/claude-x\) would break the prompt cache/);
	assert.deepEqual(fake.state.prompts, []);
	assert.deepEqual(fake.state.sets, []);
	const same = session.step({ say: "work", model: "anthropic/claude-x", thinking: "low" });
	await flush();
	fake.endTurn([{ role: "assistant", content: "done" }]);
	const result = await same;
	assert.deepEqual([result.model, result.thinking], ["anthropic/claude-x", "low"]);
});

test("a bound session waits for settled before every step, so a turn the launch or a fallback opening started ends first", async () => {
	const fake = fakePi();
	const waits: { resolve: () => void }[] = [];
	const settled = () => new Promise<void>((resolve) => void waits.push({ resolve }));
	const session = installSession(fake.pi, () => null)(fake.ctx, { settled });
	const first = session.step({ say: "one" });
	await flush();
	assert.equal(waits.length, 1);
	assert.deepEqual(fake.state.prompts, [], "no prompt before the session settled");
	waits[0]!.resolve();
	await flush();
	assert.deepEqual(fake.state.prompts, ["one"]);
	fake.endTurn();
	await first;
	const second = session.step({ say: "two" });
	await flush();
	assert.equal(waits.length, 2, "again before the second step");
	waits[1]!.resolve();
	await flush();
	fake.endTurn();
	await second;
	assert.deepEqual(fake.state.prompts, ["one", "two"]);
});

test("in a harness that reaches tools through codemode or mcp aliases, a no-tools step still lets the model submit: the container and the aliased submit pass, nested tools stay blocked", async () => {
	const fake = fakePi();
	const session = installSession(fake.pi, () => null)(fake.ctx);
	const outcome = session.step({ say: "think", tools: [], schema: { type: "object", required: ["plan"], properties: { plan: { type: "string" } } } });
	await flush();
	assert.equal(fake.toolCall("codemode"), undefined, "codemode is the transport; its nested calls meet this hook one by one");
	assert.equal(fake.toolCall("mcp__builtin_codemode__codemode"), undefined);
	assert.equal(fake.toolCall("mcp__autopilot__autopilot_submit"), undefined, "the aliased submit is the submit");
	assert.equal(fake.toolCall("autopilot_submit"), undefined);
	assert.equal(fake.toolCall("bash")?.block, true, "a nested bash is still blocked");
	assert.equal(fake.toolCall("mcp__builtin_bash__bash")?.block, true);
	// No value submitted: the step reminds once, then fails; end both turns.
	fake.endTurn();
	await flush();
	fake.endTurn();
	await outcome.catch(() => undefined);
});

test("a session whose restored loadout leaves autopilot_submit inactive gets it activated once at session_start; an active one is left alone", () => {
	const fake = fakePi();
	installSession(fake.pi, () => null);
	fake.state.active = fake.state.active.filter((name) => name !== "autopilot_submit"); // the bridge restored an older tool list
	fake.fire("session_start");
	assert.ok(fake.pi.getActiveTools().includes("autopilot_submit"));
	assert.deepEqual(fake.pi.getActiveTools().slice(0, 2), ["read", "bash"], "existing order kept, submit appended");
	const calls = fake.state.sets.length;
	fake.fire("session_start");
	assert.equal(fake.state.sets.length, calls, "already active: no second loadout change");
});

test("autopilot_submit is model-only: codemode 'only' mode hides direct tools, and terminate ends a turn only for top-level results", async () => {
	const fake = fakePi();
	const session = installSession(fake.pi, () => null)(fake.ctx);
	assert.equal(fake.state.tools.autopilot_submit.exposure, "model-only");
	const asking = session.step({ say: "work", schema: { type: "string" } });
	await flush();
	assert.doesNotMatch(fake.state.prompts[0], /codemode/, "the prompt sends the model to the top-level tool");
	const result = await fake.state.tools.autopilot_submit.execute("c1", { value: "x" });
	assert.equal(result.terminate, true);
	fake.endTurn();
	assert.equal((await asking).value, "x");
});

test("review v2-4 F2: a step allows an mcp-qualified tool it inherited or named, not only its base name", async () => {
	const fake = fakePi();
	fake.state.active = ["mcp__x__read", "bash"];
	const session = installSession(fake.pi, () => null)(fake.ctx);
	const inherited = session.step({ say: "work" });
	await flush();
	assert.equal(fake.toolCall("mcp__x__read"), undefined, "the inherited qualified name passes");
	assert.equal(fake.toolCall("read"), undefined, "its base name passes too");
	fake.endTurn();
	await inherited;
	const named = session.step({ say: "work", tools: ["mcp__x__read"] });
	await flush();
	assert.equal(fake.toolCall("mcp__x__read"), undefined, "the named qualified tool passes");
	assert.equal(fake.toolCall("bash")?.block, true, "an unnamed tool stays blocked");
	fake.endTurn();
	await named;
});

test("review v2-4 F3: a lease that ends while the step waits for a settled session rejects the step at once, with no prompt", async () => {
	const fake = fakePi();
	const lease = new AbortController();
	const never = new Promise<void>(() => {});
	const session = installSession(fake.pi, () => null)(fake.ctx, { signal: lease.signal, settled: () => never });
	const outcome = session.step({ say: "work" }).then(() => "resolved", (error: Error) => error.message);
	await flush();
	lease.abort(new Error("the lease ended (forced)"));
	assert.equal(await Promise.race([outcome, new Promise((resolve) => setTimeout(() => resolve("still pending"), 200))]), "the lease ended (forced)");
	assert.deepEqual(fake.state.prompts, []);
});

test("review v2-4 F1: a step reports its turn request before it prompts, so the lease's fallback opening stands down", async () => {
	const fake = fakePi();
	const seen: number[] = [];
	const session = installSession(fake.pi, () => null)(fake.ctx, { turnRequested: () => seen.push(fake.state.prompts.length) });
	const asking = session.step({ say: "work" });
	await flush();
	assert.deepEqual(seen, [0], "reported once, before the prompt was sent");
	fake.endTurn();
	await asking;
});

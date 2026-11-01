import assert from "node:assert/strict";
import { test } from "node:test";
import autopilot from "./autopilot.ts";

function host(answers: unknown[]) {
	const commands: Record<string, any> = {};
	const messages: string[] = [];
	const pi = {
		registerCommand: (name: string, options: any) => void (commands[name] = options),
		appendEntry: () => {},
		sendMessage: (message: { content: string }) => void messages.push(message.content),
	};
	const session = {
		step: async () => ({ text: "", value: answers.shift(), tools: [], model: "m", thinking: "low" }),
		exec: async () => ({ stdout: "", stderr: "", code: 0 }),
	};
	autopilot(pi, () => session);
	const ctx = { cwd: ".", sessionManager: { getBranch: () => [] } };
	return { run: (input: string) => commands.autopilot.handler(input, ctx), messages };
}

test("/autopilot plan-run posts the autopilot's result", async () => {
	const h = host([{ steps: [{ subject: "Write code", activeForm: "Writing code" }], check: "npm test" }, { status: "done", note: "ok" }]);
	await h.run("plan-run do the thing");
	assert.deepEqual(h.messages, ['[autopilot] plan-run -> {"steps":["Write code"],"check":"npm test","passed":true}']);
});

test("an unknown autopilot is an error message, not a throw", async () => {
	const h = host([]);
	await h.run("nope");
	assert.match(h.messages[0], /no autopilot nope; known: plan-run/);
});

test("an autopilot that throws is reported as its error", async () => {
	const h = host([undefined]);
	await h.run("plan-run do the thing");
	assert.match(h.messages[0], /^\[autopilot\] plan-run -> \{"error":/);
});

/**
 * Probe for session steering: two steps in a row from one /autopilot command, with different tool limits, the second
 * one with a checked value, plus a blocked call and a choice. Shows that a command can await its own turns and that
 * the session's tools and thinking level never change (the prompt cache invariant, session.ts).
 *
 *   /autopilot steer-probe
 */
import type { Session } from "../session.ts";

export default async function steerProbe(_args: unknown, api: { pi: any; session: Session }) {
	const before = { tools: api.pi.getActiveTools(), thinking: api.pi.getThinkingLevel() };
	const first = await api.session.step({ say: "Reply with exactly: one", tools: [] });
	const second = await api.session.step({
		say: "Submit the number of letters in the word 'flow'.",
		tools: [],
		schema: { type: "object", required: ["letters"], properties: { letters: { type: "integer" } } },
	});
	const blocked = await api.session.step({ say: "Call the bash tool with the command `echo hi`, then reply done.", tools: ["read"] });
	const choice = await api.session.choose("Which is a color?", ["red", "table"], { tools: [] });
	const after = { tools: api.pi.getActiveTools(), thinking: api.pi.getThinkingLevel() };
	return {
		first: { text: first.text, tools: first.tools, thinking: first.thinking },
		second: { value: second.value, tools: second.tools, thinking: second.thinking },
		blocked: blocked.text,
		choice,
		unchanged: JSON.stringify(before) === JSON.stringify(after),
	};
}

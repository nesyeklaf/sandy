import { textOf, type Msg } from "./types.ts";

export interface ToolEvent {
	name: string;
	/** Name plus JSON of the arguments: wrappers such as a code-execution tool hide the real command in here. */
	haystack: string;
	isError: boolean;
	result: string;
}

/** What the agent actually did since the user's last message. This is the evidence side of every claim check. */
export function buildLedger(messages: Msg[]): ToolEvent[] {
	let start = 0;
	messages.forEach((m, i) => {
		if (m.role === "user") start = i + 1;
	});
	const calls = new Map<string, ToolEvent>();
	const order: ToolEvent[] = [];
	for (const m of messages.slice(start)) {
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const b of m.content) {
				if (b.type !== "toolCall") continue;
				const ev: ToolEvent = { name: b.name ?? "", haystack: `${b.name ?? ""} ${JSON.stringify(b.arguments ?? {})}`, isError: false, result: "" };
				if (b.id) calls.set(b.id, ev);
				order.push(ev);
			}
		} else if (m.role === "toolResult") {
			const ev = (m.toolCallId ? calls.get(m.toolCallId) : undefined) ?? order.find((e) => e.name === m.toolName && e.result === "");
			if (ev) {
				ev.isError = m.isError === true;
				ev.result = textOf(m);
			}
		}
	}
	return order;
}

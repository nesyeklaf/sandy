import { textOf, type Block, type Msg } from "./types.ts";

export const HEADING = "### Session update";

const SECRETS: [RegExp, string][] = [
	[/\b(sk|pk|ghp|gho|glpat|xox[abp])-?[A-Za-z0-9_-]{16,}/g, "[secret]"],
	[/(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[secret]"],
	[/((?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*)\S+/gi, "$1[secret]"],
];
export const redact = (s: string): string => SECRETS.reduce((acc, [rx, to]) => acc.replace(rx, to), s);

const clip = (s: string, max: number): string => {
	if (s.length <= max) return s;
	const head = Math.floor(max * 0.6);
	return `${s.slice(0, head)}\n[… ${s.length - max} chars cut …]\n${s.slice(s.length - (max - head))}`;
};

const block = (b: Block, textMax: number): string => {
	if (b.type === "text") return clip(b.text ?? "", textMax);
	if (b.type === "toolCall") return `[tool-call ${b.name}] ${clip(JSON.stringify(b.arguments ?? {}), 600)}`;
	return "";
};

export interface DeltaLimits {
	toolResultMaxChars: number;
	textMaxChars: number;
}

/**
 * One message becomes one deterministic text. Same input, same bytes, no timestamps: the advisor
 * context is append-only, so every byte we render once is a cache hit forever after.
 */
export function renderMessage(m: Msg, lim: DeltaLimits): string {
	if (m.role === "user") return `[user]\n${clip(textOf(m), lim.textMaxChars)}`;
	if (m.role === "assistant") {
		const body = (Array.isArray(m.content) ? m.content : []).map((b) => block(b, lim.textMaxChars)).filter(Boolean).join("\n");
		return body ? `[assistant]\n${body}` : "";
	}
	if (m.role === "toolResult") return `[tool-result ${m.toolName ?? ""} ${m.isError ? "ERROR" : "ok"}]\n${clip(textOf(m), lim.toolResultMaxChars)}`;
	return "";
}

export function renderDelta(messages: Msg[], lim: DeltaLimits): string {
	const parts = messages.map((m) => renderMessage(m, lim)).filter(Boolean);
	return redact(`${HEADING}\n${parts.join("\n\n")}`);
}

export interface WithId<T> {
	id?: string;
	message?: T;
}
/** Messages after the last one we already sent. An unknown cursor (compaction, branch switch) falls back to the tail, never to a full replay. */
export function sliceAfter<T>(entries: WithId<T>[], lastId: string | undefined, fallbackTail = 12): { messages: T[]; lastId: string | undefined } {
	const msgs = entries.filter((e): e is WithId<T> & { id: string; message: T } => e.message !== undefined && e.id !== undefined);
	const at = lastId ? msgs.findIndex((e) => e.id === lastId) : -1;
	const fresh = at >= 0 ? msgs.slice(at + 1) : lastId === undefined ? msgs.slice(-fallbackTail) : msgs.slice(-fallbackTail);
	return { messages: fresh.map((e) => e.message), lastId: msgs.at(-1)?.id ?? lastId };
}

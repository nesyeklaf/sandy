// Structural message types: the core never imports pi, so it stays testable and pi-version independent.
export interface Block {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	arguments?: Record<string, unknown>;
}
export interface Msg {
	role: string;
	content?: string | Block[];
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
	stopReason?: string;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}
export interface Reply {
	content: Block[];
	usage: Usage;
	stopReason: string;
	errorMessage?: string;
}
export interface AskOptions {
	sessionId: string;
	cacheRetention: "short" | "long";
	signal?: AbortSignal;
	maxTokens: number;
	reasoning?: string;
}
/** One model call. The advisor context passes its whole append-only history every time. */
export type CompleteFn = (ctx: { systemPrompt: string; messages: unknown[] }, opts: AskOptions) => Promise<Reply>;

export type Verdict = "belegt" | "unbelegt" | "widerlegt";
export interface Finding {
	quote: string;
	verdict: Verdict;
	why: string;
	/** What the answer should say instead of the quote: the claim as far as the evidence reaches. Empty string drops the quote. */
	fix?: string;
}
export interface Proposal {
	kind: "idea" | "intent" | "task" | "fulfil";
	title: string;
	description: string;
	outcome?: { pr?: string; command?: string; decision?: string };
	/** For intent: the first task, which the plugin creates with the intent. */
	task?: string;
	/** For task and fulfil: the intent concerned; the session's own when absent. */
	intent?: string;
	/** For fulfil: what showed the outcome met. */
	evidence?: string;
}
export interface Review {
	findings: Finding[];
	proposals: Proposal[];
	note?: string;
}

export const textOf = (m: Msg): string =>
	typeof m.content === "string" ? m.content : (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");

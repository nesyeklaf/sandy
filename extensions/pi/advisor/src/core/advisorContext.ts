import { addUsage, emptyStats, type Asker, type Stats } from "./asker.ts";
import type { CompleteFn, Reply } from "./types.ts";

export type { Stats } from "./asker.ts";

/** Added to the system prompt when the advisor runs as an agent with tools. */
export const AGENT_ADDENDUM = (maxToolCalls: number): string =>
	`You can use read-only tools: read, grep, find, ls on the project, and session_search / session_read on the full log of the session you advise. Use them only to settle a claim or a doubt the update does not settle; at most ${maxToolCalls} tool calls per update, usually none. Your final message is always the JSON object, never prose.`;

export const SYSTEM_PROMPT = `You are the advisor of another coding agent session. You never act; you only read what the session did and answer in JSON.

Each "### Session update" message is new material from the session: user messages, assistant text, tool calls and tool results. Earlier updates are already in your context; never ask for them again.

You have three jobs.
1. CLAIMS. Compare what the assistant claims with the tool calls and results in the same turn. A claim is "belegt" if a tool result shows it, "unbelegt" if nothing in the evidence shows it, "widerlegt" if the evidence shows the opposite. Quote the claim verbatim from the assistant text. For every unbelegt or widerlegt claim add "fix": the sentence that replaces the quote in the final answer, same language and style, stating only what the evidence supports (e.g. that a step was not run); "" if the quote can simply go. The answer is rewritten with your fixes, so a fix must not add new claims.
2. NOTES. When the session is heading the wrong way (ignores the user's goal, repeats a failing step, skips verification), give one short note aimed at the agent. Say nothing when everything is fine. Never restate the user's task or tell the agent to do what it is already doing; a note must name a concrete problem and the concrete fix.
3. RECORDING. You are the hand that keeps the ideas plugin complete when the agent does not. Nobody approves what you record; it counts at once, and the plugin files it. The last block of an update may be "Ideas-Stand dieser Session": the intent, idea and open tasks this session already has. Use it, never record twice.
- No intent yet and the task is clear with its own outcome (a PR merged, a command green, a decision made): record an intent. If the user voices a wish beyond the task: an idea.
- An intent exists and the session found separate, concrete work for it: record a task.
- An intent exists and the tool results show its outcome met: record a fulfil with the evidence (the command and its result, the merged PR). Without evidence, never.
- Fixed rules: no work without a task, every task belongs to an intent, plain chat needs none. When the update ends with a "MAHNUNG" line, change work ran without them: record the missing intent (with "task", its first task) or the missing task. A new intent always carries "task".
- At the end of a turn with an intent: if the tool results show the outcome met, record fulfil; if not and work remains, record the next task; if only the user can go on, say so in the note.
Only when it is new and clearly stated. Trivia is never recorded.

Answer with exactly one JSON object and nothing else:
{"findings":[{"quote":"...","verdict":"belegt|unbelegt|widerlegt","why":"...","fix":"..."}],"note":"...optional...","proposals":[{"kind":"idea|intent|task","title":"few words","description":"2-4 sentences: what and why","task":"first task, intent only","outcome":{"pr":"owner/repo#n"}|{"command":"..."}|{"decision":"..."}},{"kind":"fulfil","evidence":"what showed the outcome met"}]}
Use empty arrays and omit "note" when there is nothing. Write notes, reasons and proposals in the language the user writes. Be brief; every word costs tokens.`;

const estimate = (messages: unknown[]): number => Math.ceil(JSON.stringify(messages).length / 4);

/**
 * The advisor's own conversation. Cache rules, all from reading the OMP advisor:
 * - the system prompt is a constant, so the first cached prefix never changes;
 * - history is append-only, each delta one new user message, the reply stored exactly as received;
 * - a stable sessionId and one model for the whole life of the context;
 * - a failed call removes its user message again so the history stays valid, and the caller re-sends the same delta;
 * - the only cut is a planned reset at a token budget.
 */
export class AdvisorContext implements Asker {
	private messages: unknown[] = [];
	private lastPrompt = 0;
	readonly stats: Stats = emptyStats();

	private readonly opts: { complete: CompleteFn; sessionId: string; retention: "short" | "long"; budgetTokens: number; maxOutputTokens: number; reasoning?: string };

	constructor(opts: { complete: CompleteFn; sessionId: string; retention: "short" | "long"; budgetTokens: number; maxOutputTokens: number; reasoning?: string }) {
		this.opts = opts;
	}

	get size(): number {
		return this.messages.length;
	}

	/** Returns the reply text, or undefined when the call failed or was aborted. */
	async ask(userText: string, signal?: AbortSignal): Promise<string | undefined> {
		if (this.lastPrompt > this.opts.budgetTokens || estimate(this.messages) > this.opts.budgetTokens) this.reset();
		const userMsg = { role: "user", content: userText, timestamp: Date.now() };
		this.messages.push(userMsg);
		let reply: Reply;
		try {
			reply = await this.opts.complete(
				{ systemPrompt: SYSTEM_PROMPT, messages: this.messages },
				{ sessionId: this.opts.sessionId, cacheRetention: this.opts.retention, maxTokens: this.opts.maxOutputTokens, ...(signal && { signal }), ...(this.opts.reasoning && { reasoning: this.opts.reasoning }) },
			);
		} catch {
			return this.fail(userMsg);
		}
		if (reply.stopReason === "error" || reply.stopReason === "aborted") return this.fail(userMsg);
		this.count(reply.usage);
		this.messages.push({ ...reply, role: "assistant" });
		return reply.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
	}

	reset(): void {
		this.messages = [];
		this.lastPrompt = 0;
		this.stats.resets++;
	}

	private fail(userMsg: unknown): undefined {
		this.messages = this.messages.filter((m) => m !== userMsg);
		this.stats.failures++;
		return undefined;
	}

	private count(u: Reply["usage"]): void {
		this.stats.calls++;
		addUsage(this.stats, u);
		this.lastPrompt = u.input + u.cacheRead + u.cacheWrite;
	}
}

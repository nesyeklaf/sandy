import {
	createAgentSession,
	DefaultResourceLoader,
	defineTool,
	getAgentDir,
	loadProjectContextFiles,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { addUsage, emptyStats, type Asker, type Stats } from "../core/asker.ts";
import { AGENT_ADDENDUM, SYSTEM_PROMPT } from "../core/advisorContext.ts";
import type { AdvisorConfig } from "../core/config.ts";
import { loadContext, type ContextKit } from "./contextKit.ts";

type Model = NonNullable<ExtensionContext["model"]>;

export interface AgentAskerDeps {
	config: AdvisorConfig;
	cwd: string;
	model: Model;
	/** The context plugin (pi/context) next to this unit, when present. */
	kit?: ContextKit;
	/** The primary session's branch, read fresh on every tool call. */
	primary: () => readonly SessionEntry[];
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: undefined });

/**
 * The advisor as its own pi agent session, in memory: constant system prompt, append-only history (every delta is one
 * more user message), read-only tools, search over the primary session's log, and the context plugin for its own cuts
 * and notebook. A failed call drops the whole session; the next call starts clean and re-sends the same delta.
 */
export class AgentAsker implements Asker {
	readonly stats: Stats = emptyStats();
	private session: AgentSession | undefined;
	private count = 0;
	private promoted = false;
	/** Why the last call failed, for /advisor and the stats file. */
	lastError: string | undefined;
	private readonly d: AgentAskerDeps;

	constructor(d: AgentAskerDeps) {
		this.d = d;
	}

	get size(): number {
		return this.count;
	}

	private systemPrompt(): string {
		const { agent } = this.d.config;
		const parts = [SYSTEM_PROMPT, AGENT_ADDENDUM(agent.maxToolCalls)];
		if (agent.contextFiles) {
			const files = loadProjectContextFiles({ cwd: this.d.cwd, agentDir: getAgentDir() });
			if (files.length > 0) parts.push("## Project instructions the session must follow\n" + files.map((f) => `### ${f.path}\n${f.content}`).join("\n\n"));
		}
		return parts.join("\n\n");
	}

	private tools(kit: ContextKit) {
		const archive = () => kit.archiveOf(this.d.primary());
		return [
			defineTool({
				name: "session_search",
				label: "Session search",
				description: "Search the primary session's full log (user messages, assistant text, tool calls and results). Use it to check whether something was really done or said earlier.",
				parameters: kit.historySearchParameters as never,
				async execute(_id, p: { query: string; limit?: number; cursor?: string }, signal?: AbortSignal) {
					const r = await archive().search({ ...p, includeVisible: true }, signal);
					return text(r.text);
				},
			}),
			defineTool({
				name: "session_read",
				label: "Session read",
				description: "Read one entry of the primary session's log in full by its #id, optionally with neighbours.",
				parameters: kit.historyReadParameters as never,
				async execute(_id, p: { id: string; around?: number; offset?: number; maxChars?: number }, signal?: AbortSignal) {
					return text((await archive().read(p, signal)).text);
				},
			}),
		];
	}

	private async open(): Promise<AgentSession> {
		const { agent, model } = this.d.config;
		const kit = this.d.kit ?? (agent.contextPlugin || agent.recallPrimary ? await loadContext() : undefined);
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: this.d.cwd,
			agentDir: getAgentDir(),
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: this.systemPrompt(),
			extensionFactories: agent.contextPlugin && kit ? [{ name: "advisor-context", hidden: true, factory: kit.createContextExtension({ configFile: false }) }] : [],
		});
		await resourceLoader.reload();
		const customTools = agent.recallPrimary && kit ? this.tools(kit) : [];
		const contextTools = agent.contextPlugin && kit ? ["history_search", "history_read", "notebook"] : [];
		const { session } = await createAgentSession({
			cwd: this.d.cwd,
			model: this.d.model,
			thinkingLevel: model.reasoning as never,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(this.d.cwd),
			tools: [...agent.tools, ...customTools.map((t) => t.name), ...contextTools],
			customTools,
		});
		await session.bindExtensions({});
		this.promoted = false;
		return session;
	}

	async warm(): Promise<void> {
		try {
			this.session ??= await this.open();
		} catch (e) {
			this.lastError = (e as Error).message;
		}
	}

	async ask(userText: string, signal?: AbortSignal): Promise<string | undefined> {
		const { agent } = this.d.config;
		let calls = 0;
		let nudged = false;
		const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		let failed = false;
		let unsubscribe = (): void => undefined;
		const onAbort = (): void => void this.session?.abort();
		try {
			const session = (this.session ??= await this.open());
			unsubscribe = session.subscribe((e) => {
				if (e.type === "tool_execution_start") {
					calls++;
					// Loop guard: one corrective at the budget, a hard stop at twice the budget.
					if (calls === agent.maxToolCalls && !nudged) {
						nudged = true;
						void session.steer("Tool budget reached. Answer now with the JSON object, using only what you have seen.");
					} else if (calls >= agent.maxToolCalls * 2) void session.abort();
				}
				if (e.type === "message_end" && e.message.role === "assistant") {
					const u = (e.message as { usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }).usage;
					if (u) for (const k of Object.keys(usage) as (keyof typeof usage)[]) usage[k] += u[k] ?? 0;
					if ((e.message as { stopReason?: string }).stopReason === "error") failed = true;
				}
			});
			signal?.addEventListener("abort", onAbort);
			if (signal?.aborted) return this.fail();
			await session.prompt(userText);
			if (failed || signal?.aborted) {
				this.lastError = failed ? "model error" : "aborted";
				return this.fail();
			}
			const reply = session.getLastAssistantText();
			if (reply === undefined || reply === "") {
				this.lastError = "empty reply";
				return this.fail();
			}
			this.stats.calls++;
			this.stats.toolCalls += calls;
			addUsage(this.stats, usage);
			this.count++;
			await this.maybePromote(session, usage.input + usage.cacheRead + usage.cacheWrite);
			return reply;
		} catch (e) {
			this.lastError = (e as Error).message;
			return this.fail();
		} finally {
			unsubscribe();
			signal?.removeEventListener("abort", onAbort);
		}
	}

	/** One planned model switch (one cache break) when the context grows past a threshold. */
	private async maybePromote(session: AgentSession, promptTokens: number): Promise<void> {
		const p = this.d.config.agent.promote;
		if (this.promoted || !p.id || promptTokens < p.atTokens) return;
		this.promoted = true;
		const registry = (session as unknown as { modelRegistry?: { find(p: string, i: string): Model | undefined } }).modelRegistry;
		const next = registry?.find(p.provider, p.id);
		if (next) await session.setModel(next);
	}

	private fail(): undefined {
		this.stats.failures++;
		this.drop();
		return undefined;
	}

	private drop(): void {
		this.session?.dispose();
		this.session = undefined;
		this.count = 0;
	}

	reset(): void {
		this.drop();
		this.stats.resets++;
	}

	dispose(): void {
		this.drop();
	}
}

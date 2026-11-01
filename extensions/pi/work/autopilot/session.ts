/**
 * Session steering for /autopilot: an autopilot's code decides each turn of its own Pi session. `step` sends one prompt
 * (with the skills it names in front), limits the tools the turn may call and waits for the turn to end; with a schema
 * the model must answer through the `autopilot_submit` tool and the value is checked against it.
 *
 * Cache invariant: a step never changes the request prefix. System prompt, active tools and their order, thinking level
 * and model stay byte-identical before, during and after it, so every step reads the session's context from the prompt
 * cache. So autopilot_submit is active in every session (refused by the tool_call hook outside a step that asks for a
 * value), a step's tool limit is enforced by blocking calls, not by changing the active tools, and a step that asks
 * for another model or thinking level is refused: those are chosen when the autopilot's session is launched.
 * `ask` puts a question to the user, `choose` lets the model pick one of fixed options, `exec` runs a command.
 *
 * A step needs an idle session, so it works from the /autopilot command, not from the autopilot tool inside a running turn.
 * While a step runs, tool calls outside its tool list are blocked, also nested ones (name them, for example
 * "read", when a step allows fabric_exec); the prompt names the allowed tools. While a track is active, a step whose skills or tools (its list, else the
 * inherited active tools) the current stage does not allow is refused before it prompts (policy.ts); autopilot_submit is
 * always allowed. The track guard stays the bound for every tool call.
 *
 * A session bound to a lease's signal (api.session of a /autopilot --lease run) stops with the lease: a step after the
 * lease ended rejects before it prompts, a running turn is aborted in pi, and no reminder turn follows; exec and ask
 * are cancelled too.
 */
import { readFileSync } from "node:fs";
import { loadoutProblem, readStagePolicy, type StagePolicy } from "./policy.ts";

type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type Schema = { type?: string; enum?: unknown[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema };

export type StepOptions = {
	say: string;
	/** The tool names this turn may call (others are blocked); default: the active ones. */
	tools?: string[];
	/** Tool names this turn may not call, taken out of tools or the active ones (an autopilot that owns the task list blocks the task tools). */
	deny?: string[];
	/** Skill names whose SKILL.md is put in front of the prompt, as /skill:name does. */
	skills?: string[];
	/** "provider/model-id"; must be the session's (a step never switches it), else the step is refused. */
	model?: string;
	/** Must be the session's thinking level, else the step is refused. */
	thinking?: Thinking;
	/** JSON schema of the value the model must submit through autopilot_submit. */
	schema?: Schema;
};
/**
 * signal: the lease's (LeaseTrack.signal); it aborts when the plugin ended the lease (force, switch, abort, expiry).
 * settled: awaited before every step; resolves once a turn the step did not start (a fallback opening) has ended.
 */
/**
 * signal: the lease; the step rejects once it aborts, also while it waits for settled. settled: resolves when the session is
 * idle. turnRequested: called before a step prompts, so a lease's fallback opening stands down (pi starts the run later).
 */
export type SessionBinding = { signal?: AbortSignal; settled?: () => Promise<void>; turnRequested?: () => void };
export type StepResult = { text: string; value?: unknown; tools: string[]; model: string; thinking: string };

export type Session = {
	step(options: StepOptions): Promise<StepResult>;
	ask(question: string, options: string[]): Promise<string | undefined>;
	choose(say: string, options: string[], step?: Omit<StepOptions, "say" | "schema">): Promise<string>;
	/** killed: the timeout or the lease stopped the command; pi then reports code 0. */
	exec(command: string, args: string[], options?: { cwd?: string; timeout?: number }): Promise<{ code: number; stdout: string; stderr: string; killed: boolean }>;
};

const SUBMIT = "autopilot_submit";
/** The tool that carries other tool calls in harnesses that expose tools only inside it (pi codemode). */
const CONTAINER = "codemode";
/** A tool's own name without a harness alias prefix (mcp__<server>__name). */
function baseName(toolName: string): string {
	const at = toolName.lastIndexOf("__");
	return toolName.startsWith("mcp__") && at > 4 ? toolName.slice(at + 2) : toolName;
}

/** Returns a problem with value against schema, or undefined. Covers type, enum, required, properties and items. */
export function check(value: unknown, schema: Schema, at = "value"): string | undefined {
	if (schema.enum && !schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) return `${at} must be one of ${JSON.stringify(schema.enum)}`;
	const kind = Array.isArray(value) ? "array" : value === null ? "null" : Number.isInteger(value) ? "integer" : typeof value;
	if (schema.type && schema.type !== kind && !(schema.type === "number" && kind === "integer")) return `${at} must be ${schema.type}, got ${kind}`;
	if (kind === "object") {
		const object = value as Record<string, unknown>;
		for (const key of schema.required ?? []) if (!(key in object)) return `${at}.${key} is missing`;
		for (const [key, sub] of Object.entries(schema.properties ?? {})) {
			const problem = key in object ? check(object[key], sub, `${at}.${key}`) : undefined;
			if (problem) return problem;
		}
	}
	if (kind === "array" && schema.items) {
		for (const [index, item] of (value as unknown[]).entries()) {
			const problem = check(item, schema.items, `${at}[${index}]`);
			if (problem) return problem;
		}
	}
	return undefined;
}

/**
 * The submitted value as the step's schema wants it. Some providers hand an untyped tool parameter over as a JSON string,
 * so a string is parsed when the schema asks for anything but a string.
 */
export function submitted(value: unknown, schema: Schema): unknown {
	if (typeof value !== "string" || !schema.type || schema.type === "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** Takes a JSON answer given as text (optionally fenced) when it matches the step's schema. */
function accept(state: { schema?: Schema; value?: unknown; submitted: boolean }, text: string): void {
	const json = text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, "$1");
	try {
		const value = JSON.parse(json);
		if (state.schema && !check(value, state.schema)) Object.assign(state, { value, submitted: true });
	} catch {}
}

function lastAssistantText(messages: any[]): string {
	const last = [...messages].reverse().find((message) => message.role === "assistant");
	const content = last?.content;
	if (typeof content === "string") return content;
	return (content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("");
}

/** Registers the submit tool and the turn and gate listeners once; returns the per-command session factory. */
export function installSession(pi: any, readPolicy: () => StagePolicy | null = readStagePolicy): (ctx: any, binding?: SessionBinding) => Session {
	let current: { allowed: Set<string>; schema?: Schema; value?: unknown; submitted: boolean } | undefined;
	let turnEnded: ((messages: any[]) => void) | undefined;

	pi.registerTool({
		name: SUBMIT,
		// Declared top-level even under codemode "only" (which hides direct tools): terminate ends a turn only for
		// top-level results, so a submit through codemode would cost one more model call.
		exposure: "model-only",
		label: "Submit",
		description: "Submit the value an autopilot step asks for. Refused outside such a step.",
		parameters: { type: "object", properties: { value: {} }, required: ["value"] },
		async execute(_id: string, params: any) {
			if (!current?.schema) return { content: [{ type: "text", text: "No autopilot step expects a value." }], isError: true };
			const value = submitted(params.value, current.schema);
			const problem = check(value, current.schema);
			if (problem) return { content: [{ type: "text", text: `Rejected: ${problem}. Submit again.` }], isError: true };
			current.value = value;
			current.submitted = true;
			// The value ends the step: no model reply after it.
			return { content: [{ type: "text", text: "Recorded." }], terminate: true };
		},
	});
	// The tool must stay active for a stable prompt prefix. A host that restores an older tool list (sandy's pi bridge does,
	// from before submit was permanent) leaves it out; activate it once here, before the session's first turn.
	pi.on("session_start", () => {
		const active = pi.getActiveTools() as string[];
		if (!active.includes(SUBMIT)) pi.setActiveTools([...active, SUBMIT]);
	});
	pi.on("tool_call", (event: any) => {
		const name = baseName(event.toolName);
		if (name === SUBMIT && !current?.schema) return { block: true, reason: "No autopilot step asks for a value now." };
		// codemode only carries calls: each nested call meets this hook itself (probe b), so the step's list still binds.
		if (current && name !== CONTAINER && !current.allowed.has(name)) return { block: true, reason: `The autopilot step does not allow ${event.toolName}.` };
		return undefined;
	});
	pi.on("agent_end", (event: any) => {
		const resolve = turnEnded;
		turnEnded = undefined;
		resolve?.(event.messages ?? []);
	});

	return (ctx: any, binding: SessionBinding = {}): Session => {
		const signal = binding.signal;
		const ended = (): Error => (signal?.reason instanceof Error ? signal.reason : new Error("the lease of this session ended"));
		const throwIfEnded = () => {
			if (signal?.aborted) throw ended();
		};
		/** p, or the lease's end if that comes first (pi's waitForIdle takes no signal). */
		const untilEnded = <T>(p: Promise<T>): Promise<T> => {
			if (!signal) return p;
			return new Promise<T>((resolve, reject) => {
				const onAbort = () => reject(ended());
				if (signal.aborted) return onAbort();
				signal.addEventListener("abort", onAbort, { once: true });
				p.then(
					(value) => (signal.removeEventListener("abort", onAbort), resolve(value)),
					(error) => (signal.removeEventListener("abort", onAbort), reject(error)),
				);
			});
		};
		const skillBlocks = (names: string[]) => {
			if (names.length === 0) return "";
			const known = ctx.getSystemPromptOptions?.().skills ?? [];
			return names
				.map((name) => {
					const skill = known.find((s: any) => s.name === name);
					if (!skill) throw new Error(`no skill ${name}`);
					const body = readFileSync(skill.filePath, "utf8").replace(/^---\n[\s\S]*?\n---\n/, "").trim();
					return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>\n\n`;
				})
				.join("");
		};

		const turn = async (prompt: string): Promise<any[]> => {
			throwIfEnded();
			const turnDone = new Promise<any[]>((resolve) => (turnEnded = resolve));
			let onAbort = () => {};
			const leaseEnded = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(ended());
				signal?.addEventListener("abort", onAbort, { once: true });
			});
			leaseEnded.catch(() => {});
			binding.turnRequested?.();
			pi.sendUserMessage(prompt);
			try {
				const messages = await Promise.race([turnDone, leaseEnded]);
				// agent_end fires inside the run; the session is idle only once the run has settled.
				await ctx.waitForIdle();
				return messages;
			} catch (error) {
				// The lease ended mid-turn: stop the model's work, and let the aborted run settle before the step returns.
				ctx.abort();
				await ctx.waitForIdle();
				throw error;
			} finally {
				signal?.removeEventListener("abort", onAbort);
			}
		};

		const step = async (options: StepOptions): Promise<StepResult> => {
			throwIfEnded();
			if (binding.settled) {
				await untilEnded(binding.settled());
				throwIfEnded();
			}
			if (typeof ctx.waitForIdle !== "function" || !ctx.isIdle()) throw new Error("session.step needs an idle session: run the autopilot with /autopilot, not from the autopilot tool");
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none";
			const thinking = pi.getThinkingLevel() as string;
			const switches = [
				options.model && options.model !== model ? `model ${options.model} (the session's is ${model})` : "",
				options.thinking && options.thinking !== thinking ? `thinking ${options.thinking} (the session's is ${thinking})` : "",
			].filter(Boolean);
			if (switches.length)
				throw new Error(`session.step refused: ${switches.join(" and ")} would break the prompt cache; an autopilot session's model and thinking are chosen when it is launched`);
			const denied = new Set(options.deny ?? []);
			const tools = [
				...(options.tools ?? (pi.getActiveTools() as string[]).filter((name) => name !== SUBMIT)).filter((name) => !denied.has(baseName(name))),
				...(options.schema ? [SUBMIT] : []),
			];
			// The tools the turn may call, inherited ones included; loadoutProblem lets autopilot_submit through.
			const outsideStage = loadoutProblem(readPolicy(), { tools, skills: options.skills });
			if (outsideStage) throw new Error(`session.step refused: ${outsideStage}`);
			const allowed = tools.filter((name) => name !== SUBMIT);
			// Named only when the model could call them: an inactive tool needs no word in the prompt.
			const blocked = (pi.getActiveTools() as string[]).map(baseName).filter((name) => denied.has(name));
			const named = options.tools
				? allowed.length
					? `\n\nTools for this step: ${allowed.join(", ")}.`
					: "\n\nThis step allows no tools."
				: blocked.length
					? `\n\nNot in this step: ${blocked.join(", ")}.`
					: "";
			const prompt =
				skillBlocks(options.skills ?? []) +
				options.say +
				named +
				(options.schema ? `\n\nAnswer by calling the ${SUBMIT} tool with a value matching this JSON schema:\n${JSON.stringify(options.schema)}` : "");
			// Matched by base name on both sides: the hook reads mcp__x__read as read, so an allowed mcp__x__read is read too.
			const state = { allowed: new Set(tools.map(baseName)), schema: options.schema, submitted: false } as NonNullable<typeof current>;
			current = state;
			try {
				let messages = await turn(prompt);
				let text = lastAssistantText(messages);
				// A model that answers with the JSON as text instead of calling the tool gets that text checked, then one reminder.
				if (options.schema && !state.submitted) accept(state, text);
				if (options.schema && !state.submitted) {
					messages = await turn(`You did not call ${SUBMIT}. Call it now with the value; do not answer in text.`);
					text = lastAssistantText(messages);
					if (!state.submitted) accept(state, text);
				}
				throwIfEnded();
				if (options.schema && !state.submitted) throw new Error(`the model ended the step without a valid ${SUBMIT} (tools ${tools.join(",") || "none"}; text: ${text.slice(0, 300)})`);
				return { text, value: state.value, tools, model, thinking };
			} finally {
				current = undefined;
				turnEnded = undefined;
			}
		};

		return {
			step,
			async ask(question, options) {
				throwIfEnded();
				if (!ctx.hasUI) throw new Error(`session.ask needs a UI: ${question}`);
				const answer = await ctx.ui.select(question, options, signal ? { signal } : undefined);
				throwIfEnded();
				return answer ?? undefined;
			},
			async choose(say, options, rest = {}) {
				const schema = { type: "object", required: ["choice"], properties: { choice: { enum: options } } };
				const result = await step({ ...rest, say, schema });
				return (result.value as { choice: string }).choice;
			},
			async exec(command, args, options = {}) {
				throwIfEnded();
				const result = await pi.exec(command, args, signal ? { ...options, signal } : options);
				return { code: result.code, stdout: result.stdout, stderr: result.stderr, killed: Boolean(result.killed) };
			},
		};
	};
}

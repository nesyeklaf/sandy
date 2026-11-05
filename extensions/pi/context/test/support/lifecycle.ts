import { mkdtempSync } from "node:fs";
import { citingAnswer } from "./historian.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { type AttemptEntry, readAttemptEntry } from "../../src/core/attempts.ts";
import { ATTEMPT_KIND, SUMMARY_KIND } from "../../src/core/kinds.ts";
import { type ContextExtensionOptions, createContextExtension, type Summarizer } from "../../src/pi/extension.ts";
import type { SummarizeRequest, SummarizeResult } from "../../src/historian/run.ts";
import { type FauxContext, type FauxRegistration, piAi, piSdk } from "./pi.ts";

/*
 * A pi runtime for historian lifecycle tests: pi's real session runtime and print mode, a faux main model that
 * answers at once, and a fake historian transport the test releases by hand, so no test waits for time to pass.
 */

export type Manager = ReturnType<typeof piSdk.SessionManager.create>;
export type Runtime = Awaited<ReturnType<typeof piSdk.createAgentSessionRuntime>>;

export interface Deferred<T = void> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly settled: () => boolean;
}

export function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let done = false;
	const promise = new Promise<T>((settle) => {
		resolve = (value) => {
			done = true;
			settle(value);
		};
	});
	return { promise, resolve, settled: () => done };
}


/** The historian's transport: every call is traced and waits for `release` or for its abort signal. */
export class FakeTransport {
	readonly requests: SummarizeRequest[] = [];
	readonly sent = deferred();
	readonly #release = deferred();
	readonly #trace: string[];

	constructor(trace: string[]) {
		this.#trace = trace;
	}

	/** The answer arrives. */
	release(): void {
		this.#release.resolve();
	}

	readonly summarize: Summarizer = (request) => {
		this.requests.push(request);
		this.#trace.push("transport:sent");
		this.sent.resolve();
		return new Promise<SummarizeResult>((resolve, reject) => {
			const onAbort = () => {
				this.#trace.push("transport:signal-aborted");
				reject(new Error("aborted"));
			};
			void this.#release.promise.then(() => {
				if (request.signal.aborted) return;
				request.signal.removeEventListener("abort", onAbort);
				this.#trace.push("transport:answered");
				resolve({ text: citingAnswer(request.prompt) });
			});
			request.signal.addEventListener("abort", onAbort);
		});
	};
}

/** A session with enough history for one historian chunk. */
export function seededManager(dir: string, turns = 6): Manager {
	const manager = piSdk.SessionManager.create(dir, join(dir, "sessions"));
	let clock = Date.UTC(2026, 9, 9, 12, 0, 0);
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (let turn = 0; turn < turns; turn++) {
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Question ${turn}: ${"word ".repeat(120)}` }],
			timestamp: ++clock,
		} as never);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `Answer ${turn}: ${"fact ".repeat(120)}` }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage,
			stopReason: "stop",
			timestamp: ++clock,
		} as never);
	}
	return manager;
}

/** A stand-in for pi's interactive UI: every method does nothing, which makes `hasUI` true. */
export const interactiveUi = new Proxy({}, { get: () => () => undefined }) as never;

export function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "context-lifecycle-"));
}

/** Extension options that make a small seeded session eligible for the historian at once. */
export function lifecycleOptions(ledgerFile: string, summarize: Summarizer | undefined, chunkMinTokens = 100): ContextExtensionOptions {
	return {
		configFile: false,
		ledgerFile,
		keepWarm: false,
		...(summarize ? { summarize } : {}),
		config: {
			watermarkTokens: 20_000,
			keepRecentTokens: 1_000,
			maskedTokens: 500,
			pinnedUserTokens: 300,
			summaryTokens: 400,
			coldCutMinTokens: 8_000,
			historian: { startTokens: 1, chunkMinTokens, chunkMaxTokens: 40_000, maxOutputTokens: 500 },
		},
	};
}

export interface RuntimeOptions {
	readonly dir: string;
	readonly manager: Manager;
	readonly options: ContextExtensionOptions;
	readonly trace: string[];
	/** Awaited by the first handler of every agent run: holds the run until the test lets it go on. */
	readonly beforeAgent?: () => Promise<unknown>;
	/** Awaited at the end of every agent run. */
	readonly onAgentEnd?: () => Promise<unknown>;
	/** Called for every entry the extension appends to the session. */
	readonly onAppend?: (kind: string) => void;
	/** Other extensions loaded before the context extension, sharing pi's event bus with it. */
	readonly extensions?: readonly ((pi: ExtensionAPI) => void)[];
	/** More faux models beside the main one, for the historian to name. */
	readonly models?: readonly string[];
	/** Answers a request to a faux model; undefined lets the default "ok" answer. */
	readonly respond?: FauxResponder;
}

/** What a faux model is asked: the context, the request options as pi-ai received them, and the model. */
export type FauxResponder = (context: FauxContext, options: Record<string, unknown> | undefined, model: { id: string; provider: string }) => unknown;

/** The runtime under test, with the context extension loaded after a probe that traces pi's own events. */
export async function openRuntime(settings: RuntimeOptions): Promise<{ runtime: Runtime; faux: FauxRegistration }> {
	const { dir, manager, options, trace } = settings;
	const faux = piAi.registerFauxProvider({
		models: ["faux-main", ...(settings.models ?? [])].map((id) => ({ id, reasoning: false, contextWindow: 200_000, maxTokens: 4_096 })),
	});
	faux.setResponses(
		Array.from({ length: 200 }, () => (context, requestOptions, _state, requested) =>
			settings.respond?.(context, requestOptions, requested) ?? piAi.fauxAssistantMessage("ok"),
		),
	);
	const model = faux.getModel();
	const probe = (pi: ExtensionAPI) => {
		pi.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				input: registered.input,
				cost: registered.cost,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
			})),
		});
		pi.on("before_agent_start", async () => {
			await settings.beforeAgent?.();
			return undefined;
		});
		pi.on("turn_end", () => {
			trace.push("turn_end");
			return undefined;
		});
		pi.on("agent_end", async () => {
			trace.push("agent_end");
			await settings.onAgentEnd?.();
		});
		pi.on("session_shutdown", (event) => {
			trace.push(`session_shutdown:${event.reason}`);
		});
	};
	const context = createContextExtension(options);
	const observed = (pi: ExtensionAPI) =>
		context(
			new Proxy(pi, {
				get(target, key) {
					if (key === "appendEntry") {
						return (kind: string, data?: unknown) => {
							// Attempt records are read from the session; they do not belong in the ordered trace of events.
							if (kind !== ATTEMPT_KIND) trace.push(`append:${kind}`);
							target.appendEntry(kind, data);
							settings.onAppend?.(kind);
						};
					}
					const value = Reflect.get(target, key);
					return typeof value === "function" ? value.bind(target) : value;
				},
			}),
		);
	const create: Parameters<typeof piSdk.createAgentSessionRuntime>[0] = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await piSdk.createAgentSessionServices({
			cwd,
			agentDir: dir,
			resourceLoaderOptions: {
				extensionFactories: [probe, ...(settings.extensions ?? []), observed],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		return {
			...(await piSdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: model as never })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await piSdk.createAgentSessionRuntime(create, { cwd: dir, agentDir: dir, sessionManager: manager });
	return { runtime, faux };
}

/** The attempt records stored in a session, oldest first. */
export function attemptEntries(manager: Manager): AttemptEntry[] {
	return manager.getEntries().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== ATTEMPT_KIND) return [];
		const record = readAttemptEntry(entry.data);
		return record ? [record] : [];
	});
}

/** What the attempt records say, as one word each: `start`, or `end:<outcome>`. */
export const attemptWords = (manager: Manager): string[] =>
	attemptEntries(manager).map((record) => (record.type === "end" ? "end:" + record.outcome : record.type));

export function summaryEntries(manager: Manager): SessionEntry[] {
	return manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === SUMMARY_KIND);
}

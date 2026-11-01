/**
 * The main requests as they were handed to the provider, which the keep-warm ping replays and the historian's fork
 * extends: both read the prefix the provider cached for the newest one, so the pool owns that prefix's one cache clock
 * (when the provider last read it) and the admission of a refresh: a ping or a fork starts only while no other request
 * reads the prefix (theirs, or pi's own warmer), and a fork waits for the one out instead of reading beside it.
 * Provider wire formats of the capture stay in this module.
 */
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions, ToolResultMessage } from "@earendil-works/pi-ai";
import { requestShape, type RequestShape } from "../core/continuity.ts";

/** Captures the pool keeps: the newest main request, and the one before it. */
export const CAPTURE_LIMIT = 2;
/**
 * The pool's ceiling in UTF-8 bytes of the serialized payloads: a capture that does not fit beside the newer ones is
 * dropped, a larger one is never kept.
 */
export const CAPTURE_BYTES = 8 * 1024 * 1024;
/** Share of the predicted prefix the provider must report as read from its cache, or the fork counts as a miss. */
export const FORK_HIT_SHARE = 0.95;

/**
 * How long a refresh out may hold another back without reporting its end: pi's own warmer, whose aborted or dropped
 * request reports nothing, and the ping, which a waiting fork waits for no longer than this.
 */
export const REFRESH_LEASE_MS = 120_000;

/** Provider APIs whose request the fork knows how to extend. */
export const FORK_APIS: ReadonlySet<string> = new Set(["anthropic-messages"]);
/** Output limit fields of the request formats pi-ai sends; pi's cache warmer sets them to one token. */
const OUTPUT_LIMITS = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;
/** Request fields that hand the provider work of its own to run: MCP servers, a code execution container. */
const SERVER_FIELDS = ["mcp_servers", "container"] as const;
/**
 * Message blocks a fork may carry: content, signed thinking, client tool calls and their results, and the tool
 * changes pi-ai declares inline. Any other block (a provider's own tool call or result, or a type this module does not
 * know) may stand for work the provider runs, so a capture holding one is not forked.
 */
const CLIENT_BLOCKS: ReadonlySet<string> = new Set(["text", "image", "document", "thinking", "redacted_thinking", "tool_use", "tool_result", "tool_addition", "tool_removal"]);

/** A model as the route needs it: what the provider is asked, where, and at what price per million tokens. */
export interface RouteModel {
	readonly provider: string;
	readonly id: string;
	readonly api: string;
	readonly baseUrl: string;
	/** Base prices, and the tiers a whole prompt above a token count is priced at instead. */
	readonly cost?: Model<Api>["cost"];
}

/** The route a request goes: model, API and endpoint. A same-name model on another route has another cache. */
export function routeOf(model: RouteModel): string {
	return `${model.provider}/${model.id} ${model.api} ${model.baseUrl}`;
}

/** One main request as it was handed to the provider. */
export interface Capture {
	readonly route: string;
	readonly api: string;
	/** The payload serialized at capture: later changes to pi's object cannot reach it, and {@link CapturePool.unchanged} compares against it. */
	readonly json: string;
	/** UTF-8 bytes of `json` and of the exchange kept with it. */
	bytes: number;
	readonly shape: RequestShape;
	/** It hands the provider tools or servers to run on its side, which a fork must not run again. */
	readonly serverSide: boolean;
	/** The fixed thinking budget it asks for, which the fork keeps and must leave room for; unset without one. */
	readonly thinkingBudget?: number;
	/** Request start, epoch ms. */
	readonly at: number;
	/**
	 * When a request last had the provider read this prefix, epoch ms: the request itself, then every ping and fork
	 * that read it from the cache. The cache lifetime counts from it. Advance it with {@link CapturePool.touch}.
	 */
	touchedAt: number;
	/**
	 * The headers the request left with, after every `before_provider_headers` handler ran: a provider may route a request
	 * to its cache by a header, so a replay or a fork of this prefix sends them too (see {@link replayHeaders}).
	 */
	readonly headers?: Readonly<Record<string, string | undefined>>;
	/** Prompt tokens the provider reported for its answer: what the cache holds. Unset until the answer arrived. */
	promptTokens?: number;
	/** The main model's own answer to it, as pi received it: the exchange a fork continues starts with it. */
	reply?: AssistantMessage;
	/** The results of the tools that answer called, as they arrived. */
	readonly results: ToolResultMessage[];
}

/**
 * The finished exchange of a capture: the main model's answer, then the result of every tool it called, in the order
 * of the calls. Unset while the answer or a result is missing, and for an answer that did not end normally (an error,
 * an abort, or the output limit), since pi then sends no such exchange to the main model.
 */
export function completedExchange(capture: Capture): readonly [AssistantMessage, ...ToolResultMessage[]] | undefined {
	const reply = capture.reply;
	if (!reply || (reply.stopReason !== "stop" && reply.stopReason !== "toolUse")) return undefined;
	const results: ToolResultMessage[] = [];
	for (const block of reply.content) {
		if (block.type !== "toolCall") continue;
		const result = capture.results.find((candidate) => candidate.toolCallId === block.id);
		if (!result) return undefined;
		results.push(result);
	}
	return [reply, ...results];
}

export type CaptureVerdict = "kept" | "warming" | "unshaped" | "oversized";

/** Who has a request out that reads the newest capture's prefix: the keep-warm ping, the fork, or pi's own warmer. */
export type RefreshKind = "warm" | "fork" | "native";

/** A request out that reads a capture's prefix. */
interface Refresh {
	readonly kind: RefreshKind;
	/** Wall time it started, epoch ms. */
	readonly wall: number;
	/** How long it holds the others back, from `wall`. */
	readonly maxMs: number;
	/** Settles when its end is reported. */
	readonly ended: Promise<void>;
	readonly end: () => void;
}

/**
 * The newest main requests, bounded in number and bytes, with the cache clock of each and the one refresh of their
 * prefix in flight.
 */
export class CapturePool {
	#captures: Capture[] = [];
	/** The headers of the provider request being built, until the request is recorded; pi's handlers fill the object in place. */
	#headers: Record<string, string | undefined> | undefined;
	/** Requests out that read a capture's prefix. */
	readonly #refreshes = new Map<symbol, Refresh>();
	/** The payload object pi handed the hook for each capture, the one pi-ai sends unless a later hook replaces it. */
	readonly #handed = new WeakMap<Capture, unknown>();

	/**
	 * The headers pi is building for the next provider request; the object the handlers mutate, read when that request is
	 * recorded, so the capture holds what every handler left.
	 */
	headersFor(headers: Record<string, string | undefined>): void {
		this.#headers = headers;
	}

	/** Keeps a main request. A warming request (one output token) is not one, and a payload without messages neither. */
	record(payload: unknown, model: RouteModel, at: number): CaptureVerdict {
		const headers = this.#headers;
		this.#headers = undefined;
		if (isWarming(payload)) return "warming";
		const shape = requestShape(payload);
		if (!shape) return "unshaped";
		const json = JSON.stringify(payload);
		let bytes = Buffer.byteLength(json, "utf8");
		if (bytes > CAPTURE_BYTES) return "oversized";
		const thinkingBudget = fixedThinkingBudget(payload);
		const capture: Capture = {
			route: routeOf(model),
			api: model.api,
			json,
			bytes,
			shape,
			serverSide: isServerSide(payload),
			...(thinkingBudget !== undefined ? { thinkingBudget } : {}),
			at,
			touchedAt: at,
			...(headers ? { headers: { ...headers } } : {}),
			results: [],
		};
		this.#handed.set(capture, payload);
		const kept: Capture[] = [capture];
		for (const older of this.#captures) {
			if (kept.length >= CAPTURE_LIMIT || bytes + older.bytes > CAPTURE_BYTES) break;
			kept.push(older);
			bytes += older.bytes;
		}
		this.#captures = kept;
		return "kept";
	}

	/**
	 * The provider answered the newest request of this route: its prompt is in the cache now, and the answer opens the
	 * exchange a fork continues. An answer that does not fit the pool's byte ceiling beside its request drops the capture.
	 */
	confirm(model: RouteModel, promptTokens: number, reply?: AssistantMessage): void {
		const newest = this.#captures[0];
		if (!newest || newest.route !== routeOf(model) || newest.promptTokens !== undefined || promptTokens <= 0) return;
		newest.promptTokens = promptTokens;
		if (reply) this.#attach(newest, reply, () => (newest.reply = reply));
	}

	/** A tool result of the main session: it belongs to the newest answer that called that tool and has no result for it. */
	result(message: ToolResultMessage): void {
		const capture = this.#captures.find((candidate) =>
			candidate.reply?.content.some((block) => block.type === "toolCall" && block.id === message.toolCallId),
		);
		if (!capture || capture.results.some((result) => result.toolCallId === message.toolCallId)) return;
		this.#attach(capture, message, () => capture.results.push(message));
	}

	/**
	 * Adds part of an exchange to its capture within the byte ceiling: the other captures leave, oldest first, until the
	 * pool fits; a capture that cannot fit with its exchange leaves itself.
	 */
	#attach(capture: Capture, part: AssistantMessage | ToolResultMessage, add: () => void): void {
		const bytes = Buffer.byteLength(JSON.stringify(part), "utf8");
		if (capture.bytes + bytes > CAPTURE_BYTES) {
			this.#captures = this.#captures.filter((candidate) => candidate !== capture);
			return;
		}
		add();
		capture.bytes += bytes;
		const others = this.#captures.filter((candidate) => candidate !== capture);
		while (this.bytes > CAPTURE_BYTES) {
			const oldest = others.pop();
			this.#captures = this.#captures.filter((candidate) => candidate !== oldest);
		}
	}

	/**
	 * Whether the payload object pi handed the hook still serializes to the capture. pi's later `before_provider_request`
	 * handlers see that same object, so one that changed it in place changed what was sent, and the capture no longer
	 * holds the cached prefix. A later handler that returns a replacement object leaves this one untouched: that change
	 * stays invisible here, and only the cache reads of a sent fork show it. Check before every reuse of a capture.
	 */
	unchanged(capture: Capture): boolean {
		return this.#handed.has(capture) && JSON.stringify(this.#handed.get(capture)) === capture.json;
	}

	/**
	 * A request that started at `at` had the provider read the capture's prefix from its cache: the cache lives on from
	 * there. The clock never moves back.
	 */
	touch(capture: Capture, at: number): void {
		if (at > capture.touchedAt) capture.touchedAt = at;
	}

	/**
	 * Marks a request out that reads the prefix, whether or not another is: pi's own warmer, which this module cannot
	 * hold back, only see. The returned call ends it. `maxMs` (wall time) bounds a mark whose end may never be reported.
	 * A ping or a fork asks {@link admit} instead.
	 */
	refresh(kind: RefreshKind, maxMs = Number.POSITIVE_INFINITY): () => void {
		const token = Symbol(kind);
		let end = () => {};
		const ended = new Promise<void>((resolve) => (end = resolve));
		this.#refreshes.set(token, { kind, wall: Date.now(), maxMs, ended, end });
		return () => {
			this.#refreshes.delete(token);
			end();
		};
	}

	/**
	 * The one admission of a ping or a fork: marked out and given the call that ends it when no other request reads the
	 * prefix, refused (undefined) while one does, since that one renews the cache this one would read, so one idle
	 * window is paid once. A refused ping waits for its next tick; a refused fork waits with {@link settled} and plans
	 * again against what the refresh left.
	 */
	admit(kind: "warm" | "fork", maxMs = Number.POSITIVE_INFINITY): (() => void) | undefined {
		return this.refreshing() === undefined ? this.refresh(kind, maxMs) : undefined;
	}

	/** The kind of a refresh still out, if any. */
	refreshing(): RefreshKind | undefined {
		return this.#live()[0]?.kind;
	}

	/**
	 * Settles once no refresh is out: each ended, or its lease (`maxMs`) ran out. Rejects with the signal's reason when
	 * it aborts first.
	 */
	async settled(signal: AbortSignal): Promise<void> {
		for (;;) {
			signal.throwIfAborted();
			const live = this.#live();
			if (live.length === 0) return;
			const leaseLeft = Math.min(...live.map((refresh) => refresh.wall + refresh.maxMs)) - Date.now();
			await new Promise<void>((resolve, reject) => {
				const done = () => {
					clearTimeout(timer);
					signal.removeEventListener("abort", aborted);
					resolve();
				};
				const aborted = () => {
					clearTimeout(timer);
					reject(signal.reason);
				};
				// A waiting summary must not keep a finished process (pi -p) alive.
				const timer = Number.isFinite(leaseLeft) ? setTimeout(done, leaseLeft) : undefined;
				timer?.unref?.();
				signal.addEventListener("abort", aborted, { once: true });
				void Promise.race(live.map((refresh) => refresh.ended)).then(done);
			});
		}
	}

	/** The refreshes still out, dropping those whose lease ran out. */
	#live(): Refresh[] {
		const wall = Date.now();
		const live: Refresh[] = [];
		for (const [token, refresh] of this.#refreshes) {
			if (wall - refresh.wall < refresh.maxMs) live.push(refresh);
			else this.#refreshes.delete(token);
		}
		return live;
	}

	/** The newest capture the provider answered, of any route. */
	latest(): Capture | undefined {
		return this.#captures.find((capture) => capture.promptTokens !== undefined);
	}

	get bytes(): number {
		return this.#captures.reduce((sum, capture) => sum + capture.bytes, 0);
	}

	reset(): void {
		this.#captures = [];
		this.#headers = undefined;
		for (const refresh of this.#refreshes.values()) refresh.end();
		this.#refreshes.clear();
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A warming request asks for one output token: pi's cache warmer sends those, a main request never does. */
export function isWarming(payload: unknown): boolean {
	return isRecord(payload) && OUTPUT_LIMITS.some((field) => payload[field] === 1);
}

/** A plain client tool: untyped or typed `custom`. A provider's own tool (web search, code execution) carries its type. */
function isClientTool(tool: unknown): boolean {
	return isRecord(tool) && (tool.type === undefined || tool.type === "custom");
}

/**
 * A message block a fork may carry. A tool declared inline (`tool_addition`) must be a client tool's definition; a
 * provider's tool or a definition of another form is refused, as is every block type outside {@link CLIENT_BLOCKS}.
 */
function isClientBlock(block: unknown): boolean {
	if (!isRecord(block) || typeof block.type !== "string" || !CLIENT_BLOCKS.has(block.type)) return false;
	if (block.type !== "tool_addition") return true;
	const tool = block.tool;
	return isRecord(tool) && tool.type === "tool_definition" && isClientTool(tool.definition);
}

/**
 * A request that has the provider run something itself: a tool that is not a plain client tool (web search, code
 * execution, a server-side computer or editor tool, typed by the provider), declared in the tool list or inline in a
 * message; a message block of the provider's own tool work or of an unknown type; or MCP servers or a container.
 */
export function isServerSide(payload: unknown): boolean {
	if (!isRecord(payload)) return false;
	if (SERVER_FIELDS.some((field) => payload[field] !== undefined)) return true;
	const tools = payload.tools;
	if (Array.isArray(tools) && !tools.every(isClientTool)) return true;
	const messages = Array.isArray(payload.messages) ? payload.messages : [];
	return messages.some((message) => isRecord(message) && Array.isArray(message.content) && !message.content.every(isClientBlock));
}

/** The thinking budget of a request with fixed-budget thinking (Anthropic's `enabled`); adaptive thinking has none. */
export function fixedThinkingBudget(payload: unknown): number | undefined {
	const thinking = isRecord(payload) ? payload.thinking : undefined;
	return isRecord(thinking) && thinking.type === "enabled" && typeof thinking.budget_tokens === "number" ? thinking.budget_tokens : undefined;
}

/** The one call that sends a request of this engine's own to the provider, a fork or a ping: pi's `ctx.modelRegistry.streamSimple`. */
export type ProviderSend = (model: Model<Api>, context: Context, options: SimpleStreamOptions) => Promise<AssistantMessage>;

/** A request body as pi-ai hands it to fetch, parsed; undefined for one that is no JSON object. */
export function parseBody(body: unknown): Record<string, unknown> | undefined {
	if (typeof body !== "string") return undefined;
	try {
		const parsed: unknown = JSON.parse(body);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** Headers that carry the credential: a replay sends the current one, whatever the main request had. */
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key", "api-key", "x-goog-api-key"]);

/**
 * The headers of a request that reads a capture's prefix again: those the main request left with, except the
 * credential, which stays what pi resolves for this request (a token may have been renewed since).
 */
export function replayHeaders(base: Record<string, string | undefined>, main: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> {
	const out = { ...main };
	for (const [name, value] of Object.entries(base)) {
		const lower = name.toLowerCase();
		if (!CREDENTIAL_HEADERS.has(lower)) continue;
		for (const key of Object.keys(out)) if (key.toLowerCase() === lower) delete out[key];
		out[name] = value;
	}
	return out;
}

/** pi-ai's `transformHeaders` option for a request that reads the capture's prefix; none for a capture without headers. */
export function replayOptions(capture: Capture): { transformHeaders?: (base: Record<string, string | undefined>) => Record<string, string | undefined> } {
	const main = capture.headers;
	return main ? { transformHeaders: (base: Record<string, string | undefined>) => replayHeaders(base, main) } : {};
}

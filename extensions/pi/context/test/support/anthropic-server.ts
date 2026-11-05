import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { stableStringify } from "../../src/core/continuity.ts";

/*
 * A stand-in for Anthropic's Messages API on a local port: pi-ai's real Anthropic client talks to it, so tests see the
 * exact bytes a request carries. Its prompt cache is a model of the real one: a request reads from the cache the longest
 * run of items (system, tools, then messages) that an earlier request with the same model and settings sent, ignoring
 * cache markers as the provider does, and pays the rest as input.
 */

/** One block of an answer: text, a tool call, or signed thinking. */
export type FakeBlock =
	| { readonly type: "text"; readonly text: string }
	| { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
	| { readonly type: "thinking"; readonly thinking: string; readonly signature: string };

export interface FakeRequest {
	/** The request body as sent, byte for byte. */
	readonly raw: string;
	/** The request headers as received. */
	readonly headers?: Record<string, string | string[] | undefined>;
	readonly body: Record<string, unknown>;
	readonly cacheRead: number;
}

/**
 * How an answer's stream ends: `complete` as the provider ends a turn; `partial` breaks the connection after the
 * blocks; `error` sends an error event in place of the end; `length` stops at the output limit (`max_tokens`).
 */
export type FakeEnding = "complete" | "partial" | "error" | "length";

/** The answer to a request: its blocks; tool calls end the turn with `tool_use`. */
export type FakeResponder = (request: FakeRequest, index: number) => readonly FakeBlock[] | Promise<readonly FakeBlock[]>;

const tokensOf = (value: unknown) => Math.ceil(stableStringify(value).length / 4);

/** The items a request caches, in order, with the settings that key the cache. */
function cacheItems(body: Record<string, unknown>): { key: string; items: string[] } {
	const { messages, system, tools, stream: _stream, max_tokens: _max, ...settings } = body;
	const items = [stableStringify(system ?? null), stableStringify(tools ?? null)];
	for (const message of (messages as unknown[] | undefined) ?? []) items.push(stableStringify(message));
	return { key: stableStringify(settings), items };
}

export class FakeAnthropic {
	readonly requests: FakeRequest[] = [];
	#server: Server | undefined;
	#seen: { key: string; items: string[] }[] = [];
	responder: FakeResponder = () => [{ type: "text", text: "ok" }];
	/** How the stream of the n-th request ends. */
	ending: (request: FakeRequest, index: number) => FakeEnding = () => "complete";

	get baseUrl(): string {
		const address = this.#server?.address() as AddressInfo;
		return `http://127.0.0.1:${address.port}`;
	}

	async start(): Promise<this> {
		this.#server = createServer((request, response) => {
			void this.#answer(request).then(
				(events) => {
					response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_fake" });
					for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
					if (events.at(-1)?.type === "message_stop" || events.at(-1)?.type === "error") response.end();
					else response.destroy();
				},
				(error: unknown) => {
					response.writeHead(500, { "content-type": "application/json" });
					response.end(JSON.stringify({ type: "error", error: { type: "api_error", message: String(error) } }));
				},
			);
		});
		await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
		return this;
	}

	/** The cache expired: nothing an earlier request sent is read any more. */
	forget(): void {
		this.#seen = [];
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
	}

	/** Tokens the cache holds for this body: the longest prefix of items an earlier request with the same settings sent. */
	#cached(body: Record<string, unknown>): number {
		const next = cacheItems(body);
		let shared = 0;
		for (const earlier of this.#seen) {
			if (earlier.key !== next.key) continue;
			let index = 0;
			while (index < earlier.items.length && index < next.items.length && earlier.items[index] === next.items[index]) index++;
			// The provider reads the cache only up to the end of an earlier request; a partly shared tool list reads nothing.
			if (index >= 2) shared = Math.max(shared, index);
		}
		this.#seen.push(next);
		return next.items.slice(0, shared).reduce((sum, item) => sum + Math.ceil(item.length / 4), 0);
	}

	async #answer(request: IncomingMessage): Promise<Record<string, unknown>[]> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		const raw = Buffer.concat(chunks).toString("utf8");
		const body = JSON.parse(raw) as Record<string, unknown>;
		const cacheRead = this.#cached(body);
		const input = Math.max(1, tokensOf({ system: body.system, tools: body.tools, messages: body.messages }) - cacheRead);
		const record: FakeRequest = { raw, body, cacheRead, headers: request.headers };
		this.requests.push(record);
		const blocks = await this.responder(record, this.requests.length - 1);
		const usage = { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 };
		const events: Record<string, unknown>[] = [
			{
				type: "message_start",
				message: { id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { ...usage, output_tokens: 1 } },
			},
		];
		blocks.forEach((block, index) => {
			if (block.type === "text") {
				events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
				events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } });
			} else if (block.type === "thinking") {
				events.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
				events.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } });
				events.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } });
			} else {
				events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
				events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
			}
			events.push({ type: "content_block_stop", index });
		});
		const output = blocks.reduce((sum, block) => sum + tokensOf(block), 0);
		const ending = this.ending(record, this.requests.length - 1);
		if (ending === "partial") return events;
		if (ending === "error") return [...events, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }];
		const stop = ending === "length" ? "max_tokens" : blocks.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
		events.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { ...usage, output_tokens: output } });
		events.push({ type: "message_stop" });
		return events;
	}
}

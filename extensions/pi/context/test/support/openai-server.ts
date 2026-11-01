import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as zlib from "node:zlib";
import { stableStringify } from "../../src/core/continuity.ts";

/*
 * A stand-in for OpenAI's wire formats on a local port: the Responses API (also as the Codex backend serves it, zstd
 * bodies included) and Chat Completions, which Mistral-style and DeepSeek-style providers speak too. pi-ai's real
 * clients talk to it, so tests see the exact bytes a request carries. Its prompt cache is a model of the real one: a
 * request reads the longest run of items (instructions, tools, then message list items) that an earlier request with
 * the same settings sent, and pays the rest as input.
 */

export type FakeFormat = "responses" | "completions";

/** One block of an answer: text, or encrypted reasoning (Responses only). */
export type FakeOpenAIBlock = { readonly type: "text"; readonly text: string } | { readonly type: "reasoning"; readonly summary: string; readonly encrypted: string };

export interface FakeOpenAIRequest {
	/** The request body as received, decompressed. */
	readonly raw: string;
	readonly path: string;
	readonly body: Record<string, unknown>;
	readonly cacheRead: number;
}

/** How an answer ends: as the provider ends a turn, or at the output limit. */
export type FakeOpenAIEnding = "complete" | "length";

const tokensOf = (value: unknown) => Math.ceil(stableStringify(value).length / 4);
const LIST_KEYS = ["input", "messages"] as const;
const UNCACHED = new Set(["stream", "stream_options", "max_tokens", "max_output_tokens", "max_completion_tokens"]);

function cacheItems(body: Record<string, unknown>): { key: string; items: string[] } {
	const settings: Record<string, unknown> = {};
	for (const [name, value] of Object.entries(body)) if (!UNCACHED.has(name) && !LIST_KEYS.includes(name as never) && name !== "tools" && name !== "instructions") settings[name] = value;
	const list = (LIST_KEYS.map((key) => body[key]).find(Array.isArray) as unknown[] | undefined) ?? [];
	return { key: stableStringify(settings), items: [stableStringify(body.instructions ?? null), stableStringify(body.tools ?? null), ...list.map((item) => stableStringify(item))] };
}

export class FakeOpenAI {
	readonly requests: FakeOpenAIRequest[] = [];
	#server: Server | undefined;
	#seen: { key: string; items: string[] }[] = [];
	responder: (request: FakeOpenAIRequest, index: number) => readonly FakeOpenAIBlock[] = () => [{ type: "text", text: "ok" }];
	ending: (request: FakeOpenAIRequest, index: number) => FakeOpenAIEnding = () => "complete";

	readonly format: FakeFormat;

	constructor(format: FakeFormat) {
		this.format = format;
	}

	get baseUrl(): string {
		const address = this.#server?.address() as AddressInfo;
		return `http://127.0.0.1:${address.port}`;
	}

	async start(): Promise<this> {
		this.#server = createServer((request, response) => {
			void this.#answer(request).then(
				(events) => {
					response.writeHead(200, { "content-type": "text/event-stream" });
					for (const event of events) response.write(typeof event === "string" ? `data: ${event}\n\n` : `${this.format === "responses" ? `event: ${String(event.type)}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
					response.end();
				},
				(error: unknown) => {
					response.writeHead(500, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: String(error) } }));
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

	#cached(body: Record<string, unknown>): number {
		const next = cacheItems(body);
		let shared = 0;
		for (const earlier of this.#seen) {
			if (earlier.key !== next.key) continue;
			let index = 0;
			while (index < earlier.items.length && index < next.items.length && earlier.items[index] === next.items[index]) index++;
			if (index >= 2) shared = Math.max(shared, index);
		}
		this.#seen.push(next);
		return next.items.slice(0, shared).reduce((sum, item) => sum + Math.ceil(item.length / 4), 0);
	}

	async #answer(request: IncomingMessage): Promise<(Record<string, unknown> | string)[]> {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(chunk as Buffer);
		let bytes = Buffer.concat(chunks);
		if (request.headers["content-encoding"] === "zstd") bytes = Buffer.from((zlib as unknown as { zstdDecompressSync(b: Buffer): Buffer }).zstdDecompressSync(bytes));
		const raw = bytes.toString("utf8");
		const body = JSON.parse(raw) as Record<string, unknown>;
		const cacheRead = this.#cached(body);
		const total = tokensOf({ instructions: body.instructions, tools: body.tools, list: body.input ?? body.messages });
		const record: FakeOpenAIRequest = { raw, path: request.url ?? "", body, cacheRead };
		this.requests.push(record);
		const index = this.requests.length - 1;
		const blocks = this.responder(record, index);
		const output = blocks.reduce((sum, block) => sum + tokensOf(block), 0);
		const length = this.ending(record, index) === "length";
		return this.format === "responses" ? responsesEvents(blocks, index, total, cacheRead, output, length) : completionsEvents(blocks, index, total, cacheRead, output, length);
	}
}

function responsesEvents(blocks: readonly FakeOpenAIBlock[], n: number, total: number, cacheRead: number, output: number, length: boolean): Record<string, unknown>[] {
	const id = `resp_fake_${n}`;
	const items = blocks.map((block, index) =>
		block.type === "text"
			? { type: "message", id: `msg_${n}_${index}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: block.text, annotations: [] }] }
			: { type: "reasoning", id: `rs_${n}_${index}`, summary: [{ type: "summary_text", text: block.summary }], encrypted_content: block.encrypted },
	);
	const events: Record<string, unknown>[] = [{ type: "response.created", response: { id, status: "in_progress", output: [] } }];
	items.forEach((item, index) => {
		events.push({ type: "response.output_item.added", output_index: index, item: { ...item, ...(item.type === "message" ? { content: [] } : { summary: [] }) } });
		if (item.type === "message") events.push({ type: "response.output_text.delta", output_index: index, content_index: 0, delta: (blocks[index] as { text: string }).text });
		events.push({ type: "response.output_item.done", output_index: index, item });
	});
	const usage = { input_tokens: total, output_tokens: output, total_tokens: total + output, input_tokens_details: { cached_tokens: cacheRead }, output_tokens_details: { reasoning_tokens: 0 } };
	events.push(
		length
			? { type: "response.incomplete", response: { id, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: items, usage } }
			: { type: "response.completed", response: { id, status: "completed", output: items, usage } },
	);
	return events;
}

function completionsEvents(blocks: readonly FakeOpenAIBlock[], n: number, total: number, cacheRead: number, output: number, length: boolean): (Record<string, unknown> | string)[] {
	const chunk = (delta: Record<string, unknown>, finish: string | null) => ({ id: `chatcmpl_${n}`, object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] });
	const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	return [
		chunk({ role: "assistant", content: "" }, null),
		chunk({ content: text }, null),
		chunk({}, length ? "length" : "stop"),
		{ id: `chatcmpl_${n}`, object: "chat.completion.chunk", created: 0, model: "fake", choices: [], usage: { prompt_tokens: total, completion_tokens: output, total_tokens: total + output, prompt_tokens_details: { cached_tokens: cacheRead } } },
		"[DONE]",
	];
}

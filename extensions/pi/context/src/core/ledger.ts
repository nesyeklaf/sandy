import { type Continuity, compareShapes, hashValue, type RequestShape } from "./continuity.ts";
import { cutReason } from "./records.ts";
import { textOf } from "./messages.ts";
import { RecentMap } from "./recent.ts";

/**
 * Classes of provider requests, judged on the actual payload bytes:
 * - continued: the cached prefix carried over
 * - planned: a cut of ours changed the history on purpose
 * - external: system prompt, tools or request settings changed (outside the history view)
 * - unplanned: the history changed without a cut; the number to keep at zero
 * - rejected: the provider refused the request, so it neither read nor wrote the cache
 *
 * Requests are compared with the last request the provider accepted, because a refused
 * one leaves no cache behind to continue from.
 */
export type RequestClass = "first" | "continued" | "planned" | "external" | "unplanned" | "rejected";

export function classifyRequest(continuity: Continuity, plannedReason: string | undefined): RequestClass {
	if (continuity.kind === "first") return "first";
	if (continuity.kind === "continued") return "continued";
	if (plannedReason !== undefined) return "planned";
	return continuity.at === "head" ? "external" : "unplanned";
}

export interface JudgedRequest {
	readonly requestClass: RequestClass;
	readonly continuity: Continuity;
	readonly items: number;
	readonly model: string | undefined;
}

/**
 * Follows requests from payload to answer. A request is judged once the provider answered,
 * against the last request it accepted.
 */
export class RequestTracker {
	private accepted: RequestShape | undefined;
	private inflight: { shape: RequestShape; continuity: Continuity; model: string | undefined } | undefined;

	begin(shape: RequestShape, model: string | undefined): void {
		this.inflight = { shape, continuity: compareShapes(this.accepted, shape), model };
	}

	/** Forget the request in flight, which will get no answer. */
	abandon(): void {
		this.inflight = undefined;
	}

	/** Judge the request in flight; undefined when there is none (the payload had no message list). */
	settle(refused: boolean, plannedReason: string | undefined): JudgedRequest | undefined {
		const request = this.inflight;
		this.inflight = undefined;
		if (!request) return undefined;
		if (!refused) this.accepted = request.shape;
		return {
			requestClass: refused ? "rejected" : classifyRequest(request.continuity, plannedReason),
			continuity: request.continuity,
			items: request.shape.items.length,
			model: request.model,
		};
	}
}

export interface UsageTotals {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	cost: number;
}

export class Ledger {
	readonly counts: Record<RequestClass, number> = {
		first: 0,
		continued: 0,
		planned: 0,
		external: 0,
		unplanned: 0,
		rejected: 0,
	};
	readonly plannedByReason = new Map<string, number>();
	readonly usage: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };

	get requests(): number {
		return Object.values(this.counts).reduce((sum, count) => sum + count, 0);
	}

	record(requestClass: RequestClass, reason?: string): void {
		this.counts[requestClass]++;
		if (requestClass === "planned" && reason) {
			this.plannedByReason.set(reason, (this.plannedByReason.get(reason) ?? 0) + 1);
		}
	}

	addUsage(usage: Partial<UsageTotals>): void {
		this.usage.input += usage.input ?? 0;
		this.usage.cacheRead += usage.cacheRead ?? 0;
		this.usage.cacheWrite += usage.cacheWrite ?? 0;
		this.usage.output += usage.output ?? 0;
		this.usage.cost += usage.cost ?? 0;
	}

	report(): string[] {
		const { counts, usage } = this;
		const requests = this.requests;
		const accepted = requests - counts.rejected;
		const percent = (part: number, whole: number) => (whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "n/a");
		const reasons = [...this.plannedByReason].map(([reason, count]) => `${reason} ${count}`).join(", ");
		const prompt = promptTokens(usage);
		return [
			`Requests this process: ${requests} (continued ${counts.continued}, planned ${counts.planned}${reasons ? ` [${reasons}]` : ""}, external ${counts.external}, unplanned ${counts.unplanned}, first ${counts.first}, rejected ${counts.rejected})`,
			`Unplanned breaks: ${percent(counts.unplanned, accepted)} of accepted requests`,
			`Cache: ${percent(usage.cacheRead, prompt)} of prompt tokens read from cache, ${usage.cacheWrite.toLocaleString("en-US")} written, cost $${usage.cost.toFixed(3)}`,
		];
	}
}

/** How many conversations' ledgers stay in memory; the least recently used is evicted beyond it. */
export const LEDGER_CONVERSATIONS = 32;

/** A provider's answer as pi-ai reports it, read without trusting its shape. */
export interface Answer {
	readonly stopReason?: string;
	readonly usage?: {
		readonly input?: number;
		readonly cacheRead?: number;
		readonly cacheWrite?: number;
		readonly output?: number;
		readonly cost?: { readonly total?: number };
	};
}

/** The size of the prompt a provider answered: its input, cache reads and cache writes. */
export function promptTokens(
	usage: Pick<NonNullable<Answer["usage"]>, "input" | "cacheRead" | "cacheWrite"> | undefined,
): number {
	return (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
}

/** Whether the provider refused the request: an error or abort before it read any of the prompt. */
export function isRefused(answer: Answer): boolean {
	return (answer.stopReason === "error" || answer.stopReason === "aborted") && promptTokens(answer.usage) === 0;
}

/** An answer's usage as the ledger totals it. */
export function answerUsage(answer: Answer): UsageTotals {
	const { usage } = answer;
	return {
		input: usage?.input ?? 0,
		cacheRead: usage?.cacheRead ?? 0,
		cacheWrite: usage?.cacheWrite ?? 0,
		output: usage?.output ?? 0,
		cost: usage?.cost?.total ?? 0,
	};
}

/** The cut a request starts with: the hash of its compaction message and the reason in the cut's opening tag. */
export interface CutHead {
	readonly hash: number;
	readonly reason: string;
}

/**
 * The cut at the head of a request's messages: the first message after the system messages, when it is a user message
 * that holds a cut's opening tag. A compaction Pi's own summarizer wrote carries no tag, so a break it causes is not
 * planned.
 */
const SUMMARY_OPENING = "<summary>\n";

export function cutHead(messages: readonly unknown[]): CutHead | undefined {
	const first = messages.find((message) => (message as { role?: unknown }).role !== "system") as
		| { role?: unknown; content?: unknown }
		| undefined;
	if (first?.role !== "user") return undefined;
	// Pi hands the model a compaction's summary after its own preface, opening `<summary>`; the cut's tag opens the summary.
	const text = textOf(first.content);
	const opening = text.indexOf(SUMMARY_OPENING);
	const reason = opening < 0 ? undefined : cutReason(text.slice(opening + SUMMARY_OPENING.length));
	return reason === undefined ? undefined : { hash: hashValue(first), reason };
}

/** What the ledger records of one request: its class and hashes, never its content. */
export interface RequestRecord {
	readonly requestClass: RequestClass;
	/** The cut's reason, for a planned request. */
	readonly reason?: string;
	/** Where the request broke from the last accepted one. */
	readonly at?: "head" | number;
	readonly model: string | undefined;
	readonly shape: RequestShape;
	readonly usage: UsageTotals;
}

/**
 * One conversation's requests, judged once the provider answered. A break is planned when the request starts with a
 * cut the last accepted request did not start with; the cut stays pending until a request carrying it is accepted.
 */
export class ConversationLedger {
	readonly ledger = new Ledger();
	private readonly tracker = new RequestTracker();
	private acceptedCut: number | undefined;
	private inflight: { shape: RequestShape; cut: CutHead | undefined } | undefined;

	/** The request about to be sent; a later call for the same request replaces its shape. */
	begin(shape: RequestShape, model: string | undefined, cut: CutHead | undefined): void {
		this.inflight = { shape, cut };
		this.tracker.begin(shape, model);
	}

	abandon(): void {
		this.inflight = undefined;
		this.tracker.abandon();
	}

	settle(answer: Answer): RequestRecord | undefined {
		const request = this.inflight;
		this.inflight = undefined;
		if (request === undefined) return undefined;
		const { cut } = request;
		const reason = cut !== undefined && cut.hash !== this.acceptedCut ? cut.reason : undefined;
		const judged = this.tracker.settle(isRefused(answer), reason);
		if (judged === undefined) return undefined;
		if (judged.requestClass !== "rejected") this.acceptedCut = cut?.hash;
		const usage = answerUsage(answer);
		this.ledger.record(judged.requestClass, reason);
		this.ledger.addUsage(usage);
		return {
			requestClass: judged.requestClass,
			...(judged.requestClass === "planned" && reason !== undefined ? { reason } : {}),
			...(judged.continuity.kind === "broken" ? { at: judged.continuity.at } : {}),
			model: judged.model,
			shape: request.shape,
			usage,
		};
	}
}

/** The ledgers of at most `limit` conversations, the least recently used evicted first. */
export class Ledgers<Id> {
	private readonly byConversation: RecentMap<Id, ConversationLedger>;

	constructor(limit: number = LEDGER_CONVERSATIONS) {
		this.byConversation = new RecentMap(limit);
	}

	get size(): number {
		return this.byConversation.size;
	}

	/** The conversation's ledger, a new one when it has none in memory; it becomes the most recently used. */
	get(id: Id): ConversationLedger {
		return this.byConversation.get(id) ?? this.byConversation.set(id, new ConversationLedger());
	}
}

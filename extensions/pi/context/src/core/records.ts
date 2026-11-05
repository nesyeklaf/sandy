import { type AttemptEntry, normalizeUsage, readAttemptEntry, type UsageFigures } from "./attempts.ts";
import { type CapShadowRecord, readCapShadowRecord } from "./cap-record.ts";
import { type CutDetails, REASON_WORD } from "./cut.ts";
import { type DuplicateRecord, readDuplicateRecord } from "./duplicates.ts";
import { CUT_DETAILS_KEY, CUT_TAG_NAME, KIND_PREFIX } from "./kinds.ts";
import { type RetrievalRecord, readRetrievalRecord } from "./retrieval-record.ts";
import { readWarmRecord, type WarmRecord } from "./warm-record.ts";
import { readSummaryState, type SummaryState } from "./summary.ts";
import { TOOLS } from "./tools.ts";

/**
 * The one reader of what the context engine stored in a session log, under its current names and the names it wrote
 * before the rename to `context`. Users resume old sessions, so an old record must keep its meaning; nothing writes the
 * old names any more (the writers use `kinds.ts`).
 */

/** The prefix of entry kinds written before the rename. */
const OLD_KIND_PREFIX = "sandy-context.";
/** The key under a compaction's `details` that marked a cut before the rename. */
const OLD_CUT_DETAILS_KEY = "sandyContext";
/** The tag around a cut's text before the rename. */
const OLD_CUT_TAG_NAME = "sandy-context";

/**
 * A request a stored summary tells of: the historian's own, or the condenser's. `usage` is undefined when the summary
 * names none or one that cannot be read; the request is then of unknown size, never a free one.
 */
export interface SummaryRequest {
	readonly step: "summarize" | "condense";
	readonly usage: UsageFigures | undefined;
}

/** A record of this engine, decoded. `foreign` is anything another writer made: pi, the user, another extension. */
export type ContextRecord =
	| { readonly kind: "notebook"; readonly text: string }
	| {
			readonly kind: "summary";
			readonly state: SummaryState;
			/**
			 * The branch entry at which the historian read the history it summarized: every edit up to it was applied to
			 * its sources. Summaries written before this marker existed have none.
			 */
			readonly projectedThroughId?: string;
			/** The requests behind the summary: the historian's, and the condenser's when one ran. */
			readonly requests: readonly SummaryRequest[];
	  }
	| { readonly kind: "attempt"; readonly entry: AttemptEntry }
	| { readonly kind: "reminder" }
	| { readonly kind: "task-done" }
	/** An old ping turn: a custom message that asked the agent to answer ok. */
	| { readonly kind: "keep-warm" }
	/** A keep-warm side request: the record before it was sent, or its end. */
	| { readonly kind: "warm-request"; readonly warm: WarmRecord }
	/**
	 * A cache-warming decision as pi offered it to the extensions. `requestsSeen` when the request a warm would replay
	 * passed `before_provider_request`, so a warm leaving would be seen; `sent` on the record of a warm that left after a
	 * stop, which a later handler's override sent.
	 */
	| { readonly kind: "warming"; readonly piAction: "warm" | "stop"; readonly action: "warm" | "stop"; readonly veto: boolean; readonly requestsSeen: boolean; readonly sent: boolean }
	| { readonly kind: "retrieval"; readonly retrieval: RetrievalRecord }
	| { readonly kind: "duplicate"; readonly duplicate: DuplicateRecord }
	| { readonly kind: "cap-shadow"; readonly shadow: CapShadowRecord }
	| { readonly kind: "cut"; readonly details: CutDetails }
	| { readonly kind: "foreign" };

/** A record under one of this engine's names whose content cannot be read. Readers skip it rather than trust it. */
export interface InvalidRecord {
	readonly kind: "invalid";
	readonly problem: string;
	/** The requests a summary tells of even when its state cannot be read: they were paid all the same. */
	readonly requests?: readonly SummaryRequest[];
}

type RecordKind = "notebook" | "summary" | "attempt" | "reminder" | "task-done" | "keep-warm" | "warming" | "retrieval" | "duplicate" | "cap-shadow";

const KIND_NAMES: Readonly<Record<string, RecordKind>> = {
	notebook: "notebook",
	summary: "summary",
	"historian-attempt": "attempt",
	"notebook-reminder": "reminder",
	"task-done": "task-done",
	"keep-warm": "keep-warm",
	warming: "warming",
	retrieval: "retrieval",
	duplicate: "duplicate",
	"cap-shadow": "cap-shadow",
};

const FOREIGN: ContextRecord = { kind: "foreign" };
/** A cut's text opens with its tag; a tag further in is quoted by someone else's text. */
const CUT_TAG = new RegExp(`^<(?:${CUT_TAG_NAME}|${OLD_CUT_TAG_NAME}) reason="(${REASON_WORD})">`);

/**
 * The record kind of an entry's `customType`: `undefined` when another writer owns the name, `"unknown"` for a name
 * under one of this engine's prefixes that it never wrote.
 */
export function kindOf(customType: unknown): RecordKind | "unknown" | undefined {
	if (typeof customType !== "string") return undefined;
	const prefix = [KIND_PREFIX, OLD_KIND_PREFIX].find((candidate) => customType.startsWith(candidate));
	if (prefix === undefined) return undefined;
	return KIND_NAMES[customType.slice(prefix.length)] ?? "unknown";
}

/** The reason in a cut's opening tag, or undefined when the text holds no cut. */
export function cutReason(text: string): string | undefined {
	return CUT_TAG.exec(text)?.[1];
}

/** Decodes one session entry as pi stores it. */
export function decodeContextRecord(value: unknown): ContextRecord | InvalidRecord {
	if (!isObject(value)) return FOREIGN;
	switch (value.type) {
		case "custom":
		case "custom_message":
			return decodeEntry(value);
		case "compaction":
			return decodeCut(value.details);
		case "message":
			return decodeOldNotebookResult(value.message);
		default:
			return FOREIGN;
	}
}

function decodeEntry(entry: Record<string, unknown>): ContextRecord | InvalidRecord {
	const kind = kindOf(entry.customType);
	switch (kind) {
		case undefined:
			return FOREIGN;
		case "unknown":
			return { kind: "invalid", problem: `unknown record kind ${String(entry.customType)}` };
		case "notebook": {
			const text = isObject(entry.data) ? entry.data.text : undefined;
			return typeof text === "string" ? { kind, text } : { kind: "invalid", problem: "a notebook without text" };
		}
		case "summary": {
			const requests = readSummaryRequests(entry.data);
			const state = readSummaryState(entry.data);
			if (!state) return { kind: "invalid", problem: "a summary that cannot be read", requests };
			const marker = isObject(entry.data) ? entry.data.projectedThroughId : undefined;
			return typeof marker === "string" ? { kind, state, projectedThroughId: marker, requests } : { kind, state, requests };
		}
		case "attempt": {
			const attempt = readAttemptEntry(entry.data);
			return attempt ? { kind, entry: attempt } : { kind: "invalid", problem: "an attempt record that cannot be read" };
		}
		case "keep-warm": {
			// A custom message is an old ping turn; the side request is stored as a custom entry.
			if (entry.type !== "custom") return { kind };
			const warm = readWarmRecord(entry.data);
			return warm ? { kind: "warm-request", warm } : { kind: "invalid", problem: "a keep-warm record that cannot be read" };
		}
		case "warming": {
			const data = isObject(entry.data) ? entry.data : {};
			const action = (value: unknown): value is "warm" | "stop" => value === "warm" || value === "stop";
			return action(data.piAction) && action(data.action)
				? { kind, piAction: data.piAction, action: data.action, veto: data.veto === true, requestsSeen: data.requestsSeen === true, sent: data.sent === true }
				: { kind: "invalid", problem: "a warming decision that cannot be read" };
		}
		case "retrieval": {
			const retrieval = readRetrievalRecord(entry.data);
			return retrieval ? { kind, retrieval } : { kind: "invalid", problem: "a retrieval record that cannot be read" };
		}
		case "duplicate": {
			const duplicate = readDuplicateRecord(entry.data);
			return duplicate ? { kind, duplicate } : { kind: "invalid", problem: "a duplicate record that cannot be read" };
		}
		case "cap-shadow": {
			const shadow = readCapShadowRecord(entry.data);
			return shadow ? { kind, shadow } : { kind: "invalid", problem: "a cap shadow record that cannot be read" };
		}
		default:
			return { kind };
	}
}

/**
 * The historian wrote its usage onto the summary before it wrote attempt receipts, and still does; the condenser's
 * request is there only when one ran.
 */
function readSummaryRequests(data: unknown): readonly SummaryRequest[] {
	if (!isObject(data)) return [];
	const requests: SummaryRequest[] = [{ step: "summarize", usage: normalizeUsage(data.usage) }];
	if (data.condenseUsage !== undefined) requests.push({ step: "condense", usage: normalizeUsage(data.condenseUsage) });
	return requests;
}

/**
 * A compaction is a cut of this engine when its `details` carry a well-formed marker. A malformed one counts as
 * foreign: the engine never wrote it, so the history before it is not the engine's to summarize.
 */
function decodeCut(details: unknown): ContextRecord {
	if (!isObject(details)) return FOREIGN;
	const marker = details[CUT_DETAILS_KEY] ?? details[OLD_CUT_DETAILS_KEY];
	return isCutDetails(marker) ? { kind: "cut", details: marker } : FOREIGN;
}

/** Sessions written before the notebook had its own entry kept it in the notebook tool's result. */
function decodeOldNotebookResult(message: unknown): ContextRecord {
	if (!isObject(message) || message.role !== "toolResult" || message.toolName !== TOOLS.notebook.name) return FOREIGN;
	if (message.isError === true) return FOREIGN;
	const text = isObject(message.details) ? message.details.text : undefined;
	return typeof text === "string" ? { kind: "notebook", text } : FOREIGN;
}

function isCutDetails(value: unknown): value is CutDetails {
	if (!isObject(value)) return false;
	const optionalString = (field: unknown) => field === undefined || typeof field === "string";
	const unsummarized = value.unsummarized;
	return (
		value.version === 1 &&
		typeof value.reason === "string" &&
		typeof value.keptFromId === "string" &&
		optionalString(value.maskedFromId) &&
		optionalString(value.summaryThroughId) &&
		(unsummarized === undefined ||
			(isObject(unsummarized) &&
				typeof unsummarized.fromId === "string" &&
				typeof unsummarized.toId === "string" &&
				typeof unsummarized.entries === "number")) &&
		typeof value.archivedEntries === "number" &&
		typeof value.blockTokens === "number"
	);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

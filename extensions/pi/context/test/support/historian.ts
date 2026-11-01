import type { ContextConfig } from "../../src/core/config.ts";
import { type AttemptEntry, readAttemptEntry } from "../../src/core/attempts.ts";
import { commitSummary, evidenceBudget, selectEvidence } from "../../src/core/historian.ts";
import { ATTEMPT_KIND, SUMMARY_KIND } from "../../src/core/kinds.ts";
import { readSummaryState, type SummaryState } from "../../src/core/summary.ts";
import {
	type AttemptLog,
	type HistorianBranch,
	type HistorianPause,
	HistorianLifecycle,
	type HistorianRoute,
	type SummarizeRequest,
	type SummarizeResult,
} from "../../src/historian/run.ts";
import type { sessionLog } from "./session-log.ts";

type Log = ReturnType<typeof sessionLog>;

/** The entries of a historian prompt: id, the characters shown, and the text. */
export function promptEntries(prompt: string): { id: string; from: number; to: number; of: number; text: string }[] {
	const found = [...prompt.matchAll(/<entry id="([^"]+)" characters="(\d+)-(\d+)" of="(\d+)">\n([\s\S]*?)\n<\/entry>/g)];
	return found.map(([, id, from, to, of, text]) => ({
		id: id as string,
		from: Number(from),
		to: Number(to),
		of: Number(of),
		text: text as string,
	}));
}

/** A minimal valid answer: it names its stretch and cites the first entry it was shown. */
export function citingAnswer(prompt: string, state = "Seeded history summarized"): string {
	const id = promptEntries(prompt)[0]?.id ?? "none";
	return "## Topic\n- A stretch\n## Current state\n- " + state + " (#" + id + ")";
}

/**
 * A historian model that copies what it is shown: every line with RULE or FACT in it becomes a bullet citing the entry
 * it stood in, so what reaches the summary is exactly what reached the request.
 */
export function echo(prompt: string): string {
	const entries = promptEntries(prompt);
	const bullets = (word: string) =>
		entries.flatMap((one) =>
			[...one.text.matchAll(new RegExp("^.*" + word + ".*$", "gm"))].map(([line]) => "- " + line.trim() + " (#" + one.id + ")"),
		);
	const last = entries.at(-1)?.id ?? "none";
	const parts = ["## Topic", "- An echoed stretch", "## Current state", "- Done: read up to " + last + ". Next: continue (#" + last + ")"];
	const rules = bullets("RULE");
	const facts = bullets("FACT");
	if (rules.length > 0) parts.push("## Goal and how it changed", ...rules);
	if (facts.length > 0) parts.push("## Facts and findings", ...facts);
	return parts.join("\n");
}

/** The attempt records of a real session: stored as the extension does and read back through the tape. */
export function sessionAttempts(log: Log): AttemptLog {
	return {
		read: () => log.tape().state.attempts,
		append: (entry) => {
			log.manager.appendCustomEntry(ATTEMPT_KIND, entry);
		},
	};
}

/** The attempt records stored in the session, oldest first. */
export function attemptRecords(log: Log): AttemptEntry[] {
	return log.manager.getEntries().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== ATTEMPT_KIND) return [];
		const record = readAttemptEntry(entry.data);
		return record ? [record] : [];
	});
}

export interface Harness {
	readonly branch: HistorianBranch;
	readonly requests: SummarizeRequest[];
	readonly lifecycle: HistorianLifecycle;
	readonly failures: unknown[];
	/** Runs the historian over the log until it has nothing more to summarize. */
	run(): Promise<void>;
	/** Starts the historian and returns at once, as a host does at a turn. */
	start(): void;
}

/** The real historian over a real session: its summaries are appended to the session as the extension does. */
export function harness(
	log: Log,
	config: ContextConfig,
	options: {
		/** The model's answer; `model` names the route asked, one of `models`. */
		answer?: (request: SummarizeRequest, model: string) => string | SummarizeResult | Promise<SummarizeResult>;
		/** The models to ask in order, the first as `primary`, the rest as `fallback`. */
		models?: readonly string[];
		/** Real routes instead of `answer` and `models`, e.g. the fork and the isolated route of pi. */
		routes?: () => readonly HistorianRoute[];
		competing?: boolean;
		now?: () => number;
		onPause?: (pause: HistorianPause) => void;
	} = {},
): Harness {
	const requests: SummarizeRequest[] = [];
	const failures: unknown[] = [];
	const competing = options.competing === true;
	const lifecycle = new HistorianLifecycle(config, {
		onError: (error) => failures.push(error),
		...(options.now ? { now: options.now } : {}),
		...(options.onPause ? { onPause: options.onPause } : {}),
	});
	const branch: HistorianBranch = {
		attempts: sessionAttempts(log),
		routes: options.routes ?? (() =>
			(options.models ?? ["test/historian"]).map((model, index) => ({
				model,
				route: index === 0 ? "primary" : "fallback",
				call: async (request: SummarizeRequest) => {
					requests.push(request);
					const answer = options.answer ? options.answer(request, model) : echo(request.prompt);
					return typeof answer === "string" ? { text: answer } : await answer;
				},
			}))),
		next: async () => {
			const tape = log.tape();
			return selectEvidence(tape.history(), evidenceBudget(config, competing), tape.state.leafId);
		},
		write: (work, summary) => {
			const committed = commitSummary({ work, history: log.tape().history(), competing }, summary);
			if (committed.status === "stored") log.manager.appendCustomEntry(SUMMARY_KIND, summary);
			return committed;
		},
	};
	let generation = 0;
	return {
		branch,
		requests,
		lifecycle,
		failures,
		start: () => lifecycle.start(branch, ++generation),
		async run() {
			lifecycle.start(branch, ++generation);
			for (let turn = 0; turn < 5_000 && lifecycle.running > 0; turn++) await new Promise((resolve) => setImmediate(resolve));
		},
	};
}

/** The summaries stored in the session, oldest first. */
export function storedSummaries(log: Log): SummaryState[] {
	return log.manager.getBranch().flatMap((entry) => {
		if (entry.type !== "custom" || entry.customType !== SUMMARY_KIND) return [];
		const state = readSummaryState(entry.data);
		return state ? [state] : [];
	});
}

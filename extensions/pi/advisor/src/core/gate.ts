import { annotate, parseReview, rewrite } from "./verdict.ts";
import type { Review } from "./types.ts";
import type { Suspicion } from "./rules.ts";

export interface GateResult {
	text: string;
	changed: boolean;
	/** released: no rule hit; checked: advisor judged; unchecked: advisor too slow or failed. */
	outcome: "released" | "checked" | "unchecked";
	review?: Review;
	suspicions: Suspicion[];
}

export interface GateInput {
	answer: string;
	suspicions: Suspicion[];
	/** Sends the prompt to the advisor and returns its raw reply, or undefined on failure/abort. */
	ask: (prompt: string, signal: AbortSignal) => Promise<string | undefined>;
	/** The session delta the advisor has not seen yet. */
	delta: string;
	timeoutMs: number;
	onTimeout: "release" | "annotate-rules";
	/** rewrite: doubtful claims are replaced in place (default). annotate: marks plus a block at the end. */
	mode?: "rewrite" | "annotate";
}

export const gatePrompt = (delta: string, answer: string, s: Suspicion[]): string =>
	`${delta}\n\n### Final answer to check\nThe assistant is about to give this as its final answer. Judge every claim that the evidence above can settle. Quote verbatim. For each unbelegt or widerlegt claim give "fix": the sentence that replaces the quote in the final answer, in the answer's language and style, saying only what the evidence supports (for example that something was not run); "" drops the quote.\n${answer}\n\n### Rule hits\n${s.map((x) => `- [${x.rule}] "${x.quote}" (${x.why})`).join("\n")}`;

/**
 * The one place that decides what the user sees as final answer. Fails open: the answer is never held back
 * longer than timeoutMs, and the advisor can only add marks, never remove or reorder text.
 */
export async function gate(input: GateInput): Promise<GateResult> {
	const { answer, suspicions } = input;
	if (suspicions.length === 0) return { text: answer, changed: false, outcome: "released", suspicions };
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), input.timeoutMs);
	let reply: string | undefined;
	try {
		reply = await input.ask(gatePrompt(input.delta, answer, suspicions), ctl.signal);
	} finally {
		clearTimeout(timer);
	}
	const review = reply === undefined ? undefined : parseReview(reply, answer);
	if (!review) {
		if (input.onTimeout === "annotate-rules") {
			const text = annotate(answer, suspicions.map((s) => ({ quote: s.quote, verdict: s.kind, why: `${s.why} (rule only, advisor did not answer in time)` })));
			return { text, changed: text !== answer, outcome: "unchecked", suspicions };
		}
		return { text: answer, changed: false, outcome: "unchecked", suspicions };
	}
	const text = input.mode === "annotate" ? annotate(answer, review.findings) : rewrite(answer, review.findings);
	return { text, changed: text !== answer, outcome: "checked", review, suspicions };
}

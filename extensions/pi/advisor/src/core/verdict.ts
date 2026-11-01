import type { Finding, Proposal, Review } from "./types.ts";

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

const asFinding = (v: unknown): Finding | undefined => {
	if (typeof v !== "object" || v === null) return undefined;
	const o = v as Record<string, unknown>;
	if (typeof o.quote !== "string" || typeof o.why !== "string") return undefined;
	if (o.verdict !== "belegt" && o.verdict !== "unbelegt" && o.verdict !== "widerlegt") return undefined;
	return { quote: o.quote, verdict: o.verdict, why: o.why, ...(typeof o.fix === "string" && { fix: o.fix.trim() }) };
};

const asProposal = (v: unknown): Proposal | undefined => {
	if (typeof v !== "object" || v === null) return undefined;
	const o = v as Record<string, unknown>;
	if (o.kind === "fulfil") {
		if (typeof o.evidence !== "string" || !o.evidence.trim()) return undefined;
		return { kind: "fulfil", title: "", description: "", evidence: o.evidence.trim().slice(0, 400), ...(typeof o.intent === "string" && { intent: o.intent }) };
	}
	if ((o.kind !== "idea" && o.kind !== "intent" && o.kind !== "task") || typeof o.title !== "string" || typeof o.description !== "string") return undefined;
	if (!o.title.trim() || !o.description.trim()) return undefined;
	const out: Proposal = { kind: o.kind, title: o.title.trim().slice(0, 120), description: o.description.trim().slice(0, 800), ...(typeof o.intent === "string" && { intent: o.intent }), ...(o.kind === "intent" && typeof o.task === "string" && o.task.trim() && { task: o.task.trim().slice(0, 120) }) };
	if (typeof o.outcome === "object" && o.outcome !== null) {
		const oc = o.outcome as Record<string, unknown>;
		out.outcome = {
			...(typeof oc.pr === "string" && { pr: oc.pr }),
			...(typeof oc.command === "string" && { command: oc.command }),
			...(typeof oc.decision === "string" && { decision: oc.decision }),
		};
	}
	return out;
};

/** Takes the first balanced JSON object out of the reply. Anything else (prose, fences) is ignored. */
export function extractJson(text: string): unknown {
	const start = text.indexOf("{");
	if (start < 0) return undefined;
	let depth = 0;
	let inStr = false;
	for (let i = start; i < text.length; i++) {
		const c = text[i];
		if (inStr) {
			if (c === "\\") i++;
			else if (c === '"') inStr = false;
		} else if (c === '"') inStr = true;
		else if (c === "{") depth++;
		else if (c === "}" && --depth === 0) {
			try {
				return JSON.parse(text.slice(start, i + 1));
			} catch {
				return undefined;
			}
		}
	}
	return undefined;
}

/**
 * A finding is only kept when its quote really occurs in the checked answer.
 * An advisor that invents quotes would otherwise mark text the agent never wrote.
 */
export function parseReview(reply: string, answer?: string): Review | undefined {
	const raw = extractJson(reply);
	if (typeof raw !== "object" || raw === null) return undefined;
	const o = raw as Record<string, unknown>;
	const hay = answer === undefined ? undefined : norm(answer);
	const findings = (Array.isArray(o.findings) ? o.findings : []).map(asFinding).filter((f): f is Finding => !!f && (hay === undefined || (f.quote.trim().length > 0 && hay.includes(norm(f.quote)))));
	const proposals = (Array.isArray(o.proposals) ? o.proposals : []).map(asProposal).filter((p): p is Proposal => !!p);
	const note = typeof o.note === "string" && o.note.trim() ? o.note.trim().slice(0, 600) : undefined;
	return { findings, proposals, ...(note && { note }) };
}

/**
 * Rewrites the doubtful passages in place: every unbelegt or widerlegt quote becomes its fix, the rest of the answer
 * stays byte for byte. The caller stores only this text, so the old answer is gone and there is one final answer.
 * Without a fix the quote is kept and flagged inline, so no content is lost either way.
 */
export function rewrite(answer: string, findings: Finding[]): string {
	let text = answer;
	for (const f of findings) {
		if (f.verdict === "belegt") continue;
		const q = f.quote.trim();
		const at = text.indexOf(q);
		if (at < 0) continue;
		const fix = f.fix ?? `${q} (nicht belegt)`;
		const before = text.slice(0, at);
		const after = text.slice(at + q.length);
		if (fix === "") {
			const head = before.replace(/[ \t]+$/, "");
			text = head + (head === "" || head.endsWith("\n") ? "" : " ") + after.replace(/^[ \t]+/, "");
		} else text = before + fix + after;
	}
	return text;
}

/**
 * Marks doubtful passages without rewriting the answer: a footnote index after the quote, one block at the end.
 * Everything the agent wrote stays, in order. That is the point: no second answer, no lost content.
 */
export function annotate(answer: string, findings: Finding[]): string {
	const bad = findings.filter((f) => f.verdict !== "belegt");
	if (bad.length === 0) return answer;
	let text = answer;
	const notes: string[] = [];
	bad.forEach((f, i) => {
		const n = i + 1;
		const at = text.indexOf(f.quote.trim());
		if (at >= 0) {
			const end = at + f.quote.trim().length;
			text = `${text.slice(0, end)} ⚠${n}${text.slice(end)}`;
		}
		notes.push(`⚠${n} ${f.verdict}: ${f.why}`);
	});
	return `${text}\n\n---\nAdvisor-Prüfung (Antwort oben unverändert):\n${notes.map((n) => `- ${n}`).join("\n")}`;
}

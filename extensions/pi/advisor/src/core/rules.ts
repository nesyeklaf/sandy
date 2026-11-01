import type { ToolEvent } from "./ledger.ts";
import type { Msg } from "./types.ts";

export interface Suspicion {
	rule: string;
	quote: string;
	why: string;
	/** "widerlegt" when the ledger shows the opposite, "unbelegt" when it shows nothing. */
	kind: "unbelegt" | "widerlegt";
}

const TEST_CALL = /\b(vitest|jest|pytest|mocha|tsc|npm (run )?(test|build|lint)|bun (run )?(test|build)|cargo (test|check|build)|go (test|build)|make|eslint|ruff|npx tsc)\b|scripts\/build\.sh|\bnode --test\b/i;
const EDIT_CALL = /^(edit|write|multiedit|apply_patch|str_replace|aft_(move|delete|import)|ast_grep_replace)|\bpi\.(edit|write)\b|\bsed -i\b|\bgit apply\b|\bpatch\b|>>?\s*[\w./~-]+/i;
const CHANGE_CALL = /^(edit|write|multiedit|apply_patch|str_replace|aft_(move|delete|import)|ast_grep_replace)|\bpi\.(edit|write)\b|\bsed -i\b|\bgit (apply|commit|add|mv|rm)\b|\bnpm (install|i)\b/i;

/** True when the messages contain a tool call that changes files or the repo. Reads and searches are not change work. */
export function changeWork(messages: Msg[]): boolean {
	return messages.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "toolCall" && CHANGE_CALL.test(`${b.name ?? ""} ${JSON.stringify(b.arguments ?? {})}`)));
}

const NEGATION = /\b(nicht|noch nicht|kein|keine|ungetestet|nie|untested|not|never|didn'?t|haven'?t|without|ohne|unverified|unklar|offen)\b|n't/i;

interface Rule {
	id: string;
	claim: RegExp;
	evidence: (l: ToolEvent[], hit: string) => ToolEvent[];
	why: string;
	refutable?: boolean;
}

const SHIPPED: [RegExp, RegExp][] = [
	[/gepusht|pushed|\bpush\b/i, /git push/i],
	[/gemergt|merged|\bmerge\b/i, /git merge|gh pr merge|glab mr merge|push[^"]*main/i],
	[/installiert|installed/i, /install|sandy plugin|reload/i],
	[/deployed|released|ausgerollt/i, /deploy|release|reload|publish/i],
	[/committed|commit erstellt|committet/i, /git commit/i],
];

const RULES: Rule[] = [
	{
		id: "tests_pass",
		claim: /(test|build|tsc|typecheck|lint|check)\w*[^.\n]{0,40}\b(pass\w*|green|grün|bestanden|erfolgreich|ok|clean|sauber|fehlerfrei)\b|\b(pass\w*|green|grün|bestanden)[^.\n]{0,30}(test|build)|\b\d+\s*(of|von|\/)\s*\d+\b[^.\n]{0,20}(pass|bestanden|grün)/i,
		evidence: (l) => l.filter((e) => TEST_CALL.test(e.haystack)),
		why: "claims a passing test/build/typecheck, but no matching command ran in this turn",
		refutable: true,
	},
	{
		id: "file_changed",
		claim: /\b(ich habe|i('| ha)ve|i)\b(?:[^.\n]|\.(?=\S)){0,50}\b(geändert|angepasst|geschrieben|erstellt|created|changed|edited|fixed|behoben|implementiert|implemented|hinzugefügt|added|gelöscht|removed)\b/i,
		evidence: (l) => l.filter((e) => EDIT_CALL.test(e.haystack)),
		why: "claims a file change, but no edit/write call ran in this turn",
	},
	{
		id: "shipped",
		claim: /\b(gepusht|pushed|gemergt|merged|installiert|installed|deployed|released|ausgerollt|committed|committet)\b/i,
		evidence: (l, hit) => {
			const rx = SHIPPED.find(([c]) => c.test(hit))?.[1] ?? /./;
			return l.filter((e) => rx.test(e.haystack));
		},
		why: "claims a push/merge/install/deploy/commit, but no matching command ran in this turn",
		refutable: true,
	},
	{
		id: "verified",
		claim: /\b(geprüft|überprüft|verifiziert|verified|gemessen|measured|getestet|tested|nachgelesen|gelesen|gesehen)\b/i,
		evidence: (l) => l,
		why: "claims to have checked something, but no tool ran in this turn",
	},
];

const stripCode = (text: string): string => text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ");
const sentences = (text: string): string[] => stripCode(text).split(/(?<=[.!?:])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 8);

/** Deterministic first stage: cheap, no model. A hit only means "worth a second look", never "wrong". */
export function runRules(text: string, ledger: ToolEvent[], enabled: Record<string, boolean> = {}): Suspicion[] {
	const out: Suspicion[] = [];
	for (const s of sentences(text)) {
		if (NEGATION.test(s)) continue;
		for (const r of RULES) {
			if (enabled[r.id] === false) continue;
			const m = r.claim.exec(s);
			if (!m) continue;
			const ev = r.evidence(ledger, m[0]);
			const ok = ev.filter((e) => !e.isError);
			if (ok.length > 0 && !(r.refutable && ev.at(-1)?.isError)) continue;
			out.push({ rule: r.id, quote: s.slice(0, 240), why: ev.length > 0 && ev.at(-1)?.isError ? "the last matching command failed" : r.why, kind: ev.length > 0 ? "widerlegt" : "unbelegt" });
			break;
		}
	}
	return out;
}

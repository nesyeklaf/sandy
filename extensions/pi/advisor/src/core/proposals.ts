import type { Proposal } from "./types.ts";

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

/** What `sandy ideas thread <id>` prints: where the session stands in the ideas plugin. */
export interface SessionState {
	thread: string;
	intent: { id: string; title: string; state: string; doneWhen: string } | null;
	idea: { id: string; title: string } | null;
	tasks: { key: string; title: string; status: string }[];
	/** The owner's notes on the intent and its idea, oldest first. Empty from an ideas plugin that does not send them. */
	notes: OwnerNote[];
}

export interface OwnerNote {
	text: string;
	at: number;
}

export function parseState(stdout: string): SessionState | undefined {
	try {
		const o = JSON.parse(stdout) as Partial<SessionState>;
		if (typeof o !== "object" || o === null || typeof o.thread !== "string" || !("intent" in o)) return undefined;
		return { thread: o.thread, intent: o.intent ?? null, idea: o.idea ?? null, tasks: Array.isArray(o.tasks) ? o.tasks : [], notes: Array.isArray(o.notes) ? o.notes : [] };
	} catch {
		return undefined;
	}
}

/** The block at the end of an update. German like the rest of the owner's text; the model answers in the user's language anyway. */
export function renderState(s: SessionState): string {
	if (!s.intent) return "### Ideas-Stand dieser Session\nDiese Session hat noch keinen Intent.";
	const lines = ["### Ideas-Stand dieser Session", `Intent ${s.intent.id} \"${s.intent.title}\" (${s.intent.state}), fertig wenn: ${s.intent.doneWhen}`];
	if (s.idea) lines.push(`Idee ${s.idea.id} \"${s.idea.title}\"`);
	lines.push(s.tasks.length ? `Offene Tasks: ${s.tasks.map((t) => `${t.key} ${t.title} (${t.status})`).join("; ")}` : "Keine offenen Tasks.");
	return lines.join("\n");
}

/** End-of-turn question: is the intent met? Evidence closes it, otherwise the next task, otherwise the user is needed. */
export function goalCheck(s: SessionState): string | undefined {
	if (!s.intent) return undefined;
	const goal = s.intent.doneWhen ? ` Ergebnis: ${s.intent.doneWhen}.` : "";
	return `ZIELPRÜFUNG für ${s.intent.id}.${goal} Zeigen die Tool-Ergebnisse das Ergebnis erreicht, schlage fulfil mit Beleg vor. Sonst schlage den nächsten Task vor, oder nenne in der Notiz, dass der Nutzer gebraucht wird.`;
}

/** The fixed rule as a reminder: change work needs an intent and an open task. Only given when change work really ran and something is missing. */
export function reminder(s: SessionState, workSeen: boolean): string | undefined {
	if (!workSeen) return undefined;
	if (!s.intent) return "MAHNUNG: Es lief Änderungsarbeit, aber diese Session hat keinen Intent. Schlage einen Intent mit Ergebnis und erstem Task vor (Feld \"task\").";
	if (s.tasks.length === 0) return `MAHNUNG: Es lief Änderungsarbeit unter Intent ${s.intent.id}, aber es gibt keinen offenen Task. Schlage den Task vor, der diese Arbeit abdeckt.`;
	return undefined;
}

export const keyOf = (p: Proposal): string => {
	if (p.kind === "fulfil") return `fulfil:${p.intent ?? ""}`;
	return `${p.kind}:${p.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`;
};

export interface Target {
	/** The intent the session works for, when it has one. */
	intentId?: string;
	/** Task project prefix. */
	project: string;
}

/** The sandy command for a proposal, or undefined when it does not apply (no intent to hang it on, no evidence, a second intent). */
export function commandFor(p: Proposal, threadId: string | undefined, target: Target = { project: "IDEA" }): string[] | undefined {
	const intentId = p.intent ?? target.intentId;
	if (p.kind === "task") {
		if (!intentId) return undefined;
		return ["ideas", "task-add", p.title, "--project", target.project, "--description", p.description, "--intent", intentId];
	}
	if (p.kind === "fulfil") {
		if (!intentId || !p.evidence?.trim()) return undefined;
		return ["ideas", "fulfil", intentId, "--evidence", p.evidence.trim()];
	}
	if (p.kind === "intent" && target.intentId) return undefined;
	const base = ["ideas", p.kind === "idea" ? "propose-idea" : "propose-intent", p.title, "--description", p.description];
	if (threadId) base.push("--thread", threadId);
	if (p.kind === "intent") {
		const o = p.outcome;
		if (o?.pr && /^.+#\d+$/.test(o.pr)) base.push("--pr", o.pr);
		else if (o?.command) base.push("--command", o.command);
		else base.push("--decision", o?.decision ?? "Owner decides whether this is done");
		if (p.task) base.push("--task", p.task);
	}
	return base;
}

export interface Submitted {
	key: string;
	id?: string;
	error?: string;
}

/** Records what the advisor found. Nobody approves: the plugin files an intent under its idea and merges duplicate ideas. Duplicates and overflow are dropped here. */
export async function submit(proposals: Proposal[], opts: { exec: Exec; sandy: string; threadId?: string; seen: Set<string>; max: number; intentId?: string; project: string }): Promise<Submitted[]> {
	const out: Submitted[] = [];
	let intentId = opts.intentId;
	for (const p of proposals) {
		const key = keyOf({ ...p, ...(p.kind === "fulfil" && { intent: p.intent ?? intentId }) });
		if (opts.seen.has(key) || opts.seen.size >= opts.max) continue;
		const args = commandFor(p, opts.threadId, { project: opts.project, ...(intentId && { intentId }) });
		if (!args) continue;
		opts.seen.add(key);
		const r = await opts.exec(opts.sandy, args);
		if (r.code === 0 && p.kind === "intent") intentId = r.stdout.trim();
		out.push(r.code === 0 ? { key, id: r.stdout.trim() } : { key, error: (r.stderr || r.stdout).trim().slice(0, 200) });
	}
	return out;
}

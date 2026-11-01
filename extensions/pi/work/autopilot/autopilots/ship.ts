/**
 * Ship autopilot: code owns the stage, the inputs and the checks; the model only does the stage's work in its own loadout.
 *
 *   /autopilot ship review [base]      findings for the changes since base (default: the uncommitted changes)
 *   /autopilot ship release [from]     release notes for the commits since from (default: the last tag)
 *   /autopilot ship                    asks which stage (needs a UI)
 *   /autopilot --lease <ticket> ship review <base>    drives one Track stage visit: submits outputs.findings, advances
 *   /autopilot --lease <ticket> ship release <base>   drives one Track stage visit: submits outputs.notes, advances
 *
 * As a SANDY workflow worker: agent("/autopilot --report ship review origin/main", { raw: true, report: true }).
 *
 * Review: code collects the diff and its files; the model reads with read-only tools (skills understand and
 * refactor-clean) and submits findings; code keeps only findings on files the diff touches.
 * Release: code collects the commit log; the model gets no tools and writes the notes from that log.
 *
 * Model and thinking level are the worker session's: choose them when launching the worker (review wants thinking
 * high, release is fine with medium). A step cannot switch them without breaking the prompt cache (session.ts).
 *
 * With a lease the stage runs as without one, then the result goes to the lease as the stage's output (findings as one
 * markdown line per kept finding, notes as written) and the lease advances; like verify.ts, an advance refused because
 * the gate check was interrupted is retried at most twice. A stage whose template does not want that output releases
 * the lease instead of running.
 */
import type { Session } from "../session.ts";
import type { LeaseTrack } from "../track.ts";

const STAGES = ["review", "release"] as const;
type Stage = (typeof STAGES)[number];
type Finding = { severity: "high" | "medium" | "low"; title: string; file?: string; line?: number; detail?: string };

const MAX_DIFF_CHARS = 120_000;

/** Release notes come back as a submitted value: a text answer would record whatever the model says last. */
const notesSchema = { type: "object", required: ["notes"], properties: { notes: { type: "string" } } };

const findingsSchema = {
	type: "object",
	required: ["findings"],
	properties: {
		findings: {
			type: "array",
			items: {
				type: "object",
				required: ["severity", "title"],
				properties: {
					severity: { enum: ["high", "medium", "low"] },
					title: { type: "string" },
					file: { type: "string" },
					line: { type: "integer" },
					detail: { type: "string" },
				},
			},
		},
	},
};

/** "review origin/main" -> {stage: "review", ref: "origin/main"}; an unknown first word is an error, none asks. */
export function parseArgs(args: unknown): { stage?: Stage; ref?: string } {
	const words = String(typeof args === "string" ? args : ((args as any)?.stage ?? "")).trim().split(/\s+/).filter(Boolean);
	if (words.length === 0) return {};
	const stage = words[0].toLowerCase();
	if (!(STAGES as readonly string[]).includes(stage)) throw new Error(`unknown stage ${words[0]}; use ${STAGES.join(" or ")}`);
	return { stage: stage as Stage, ref: words[1] };
}

/** Splits findings into those on files the diff touches (or on no file) and those elsewhere. */
export function onChangedFiles(findings: Finding[], changed: string[]): { kept: Finding[]; dropped: Finding[] } {
	const files = new Set(changed);
	const kept: Finding[] = [];
	const dropped: Finding[] = [];
	for (const finding of findings) {
		const file = finding.file?.replace(/^\.\//, "").replace(/:\d+$/, "");
		(file === undefined || files.has(file) ? kept : dropped).push(file === undefined ? finding : { ...finding, file });
	}
	return { kept, dropped };
}

async function git(session: Session, args: string[]): Promise<string> {
	const result = await session.exec("git", args, { timeout: 60_000 });
	if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
	return result.stdout;
}

/** The files a diff touches, by their real names: -z keeps git from quoting names with unusual characters. */
export async function changedFiles(session: Session, range: string[]): Promise<string[]> {
	return (await git(session, ["diff", "--name-only", "-z", ...range])).split("\0").filter(Boolean);
}

async function review(session: Session, base?: string) {
	const range = base ? [base] : ["HEAD"];
	const files = await changedFiles(session, range);
	if (files.length === 0) return { stage: "review", base: base ?? "uncommitted", files, findings: [], dropped: [], note: "no changes" };
	const diff = await git(session, ["diff", ...range]);
	const shown = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff cut at ${MAX_DIFF_CHARS} characters; read the files for the rest]` : diff;
	const result = await session.step({
		say:
			`Review these changes (git diff ${range.join(" ")}). Read the touched files where the diff is not enough. ` +
			`Report real defects only: wrong behavior, broken contracts, missing failure handling. No style remarks. ` +
			`Give every finding the file path as in the diff.\n\nFiles: ${files.join(", ")}\n\n\`\`\`diff\n${shown}\n\`\`\``,
		tools: ["read", "grep", "find", "ls"],
		skills: ["understand", "refactor-clean"],
		schema: findingsSchema,
	});
	const { kept, dropped } = onChangedFiles((result.value as { findings: Finding[] }).findings, files);
	return { stage: "review", base: base ?? "uncommitted", files, findings: kept, dropped };
}

async function release(session: Session, from?: string) {
	const start = from ?? (await session.exec("git", ["describe", "--tags", "--abbrev=0"])).stdout.trim();
	const log = await git(session, ["log", "--no-merges", "--format=%h %s%n%b", start ? `${start}..HEAD` : "HEAD"]);
	if (!log.trim()) return { stage: "release", from: start || null, notes: "", note: "no commits" };
	const result = await session.step({
		say:
			`Write release notes in Markdown for these commits${start ? ` since ${start}` : ""}. Group by user-visible change, ` +
			`lead with what changed for the user, leave out pure refactors and test-only commits. Submit the notes as the value notes.\n\n${log}`,
		tools: [],
		skills: ["write-docs"],
		schema: notesSchema,
	});
	return { stage: "release", from: start || null, notes: String((result.value as { notes: string }).notes).trim() };
}

const RETRIES = 2;

/** One line per kept finding, "No findings." when none, plus a line counting the findings dropped for being off the diff. */
export function findingsMarkdown(kept: Finding[], dropped: Finding[]): string {
	const lines = kept.map((finding) => {
		const where = finding.file ? ` (${finding.file}${finding.line === undefined ? "" : `:${finding.line}`})` : "";
		return `- [${finding.severity}] ${finding.title}${where}${finding.detail ? `: ${finding.detail}` : ""}`;
	});
	if (lines.length === 0) lines.push("No findings.");
	if (dropped.length > 0) lines.push(`Dropped ${dropped.length} finding(s) on files the diff does not touch.`);
	return lines.join("\n");
}

/** Runs the stage visit on a lease: submits the stage's result as the one output ship writes, then advances. */
async function driveLease(lease: LeaseTrack, stage: Stage, ref: string | undefined, session: Session) {
	const output = stage === "review" ? "findings" : "notes";
	const station = lease.station;
	if (!station.missingOutputs.includes(output)) {
		return lease.release(`ship ${stage} writes the output "${output}", but stage "${station.stage}" expects ${station.missingOutputs.length ? station.missingOutputs.join(", ") : "no outputs"}; fix the template`);
	}
	const result = stage === "review" ? await review(session, ref) : await release(session, ref);
	const text =
		"findings" in result
			? findingsMarkdown(result.findings, result.dropped)
			: result.notes || `No commits${result.from ? ` since ${result.from}` : ""}.`;
	await lease.submit({ outputs: { [output]: text } });
	const attempts = [];
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		const next = await lease.advance({ note: `ship ${stage}` });
		attempts.push(next.kind === "refused" ? { refused: next.reasons } : { kind: next.kind });
		if (next.kind !== "refused" || !next.reasons.some((reason) => reason.includes("interrupted"))) break;
	}
	return { ...result, attempts };
}

export default async function ship(args: unknown, api: { session: Session; lease?: LeaseTrack | null }) {
	const parsed = parseArgs(args);
	const stage = parsed.stage ?? (await api.session.ask("Which stage?", ["review", "release"]))?.toLowerCase();
	if (stage !== "review" && stage !== "release") return { stage: null };
	if (api.lease) return driveLease(api.lease, stage, parsed.ref, api.session);
	return stage === "review" ? review(api.session, parsed.ref) : release(api.session, parsed.ref);
}

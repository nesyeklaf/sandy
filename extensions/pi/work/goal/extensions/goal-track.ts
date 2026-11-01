/**
 * The goal's view of the track (sandy/work/track) running in this SANDY thread. It reads the track's policy file, the same
 * file the guard enforces (contract: sandy/work/track/POLICY.md), and never writes it. A missing or unreadable file means
 * "no track": the goal works as without one.
 *
 * Two uses, both loose: while the track waits (owner approval, gate checks) the scheduler queues no auto-continuation,
 * because the track messages the agent when the wait ends; and a focused goal's request context names the stage.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type TrackView = {
	machine: string;
	stage: string;
	stageTitle: string;
	next: string[];
	/** The goal the run serves; null when it started without one or the file predates the field. */
	goalId: string | null;
	/** "owner": gate approval or force proposal in the composer; "track": checks or a run; null: the driver works. */
	waiting: "owner" | "track" | null;
};

type Env = Record<string, string | undefined>;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function readTrack(env: Env = process.env): TrackView | null {
	const threadId = env.SANDY_THREAD_ID;
	if (!threadId || !/^[A-Za-z0-9_-]+$/.test(threadId)) return null;
	const dir = env.TRACK_STATE_DIR || join(env.HOME || homedir(), ".local/state/sandy-track");
	let raw: unknown;
	try { raw = JSON.parse(readFileSync(join(dir, "threads", `${threadId}.json`), "utf8")); } catch { return null; }
	if (!isObject(raw) || raw.version !== 1) return null;
	// Files that predate "running" are live while active.
	const running = typeof raw.running === "boolean" ? raw.running : raw.active === true;
	if (!running || typeof raw.stage !== "string" || !raw.stage) return null;
	return {
		machine: typeof raw.machine === "string" ? raw.machine : "?",
		stage: raw.stage,
		stageTitle: typeof raw.stageTitle === "string" && raw.stageTitle ? raw.stageTitle : raw.stage,
		next: Array.isArray(raw.next) ? raw.next.filter((item): item is string => typeof item === "string") : [],
		goalId: typeof raw.goalId === "string" && raw.goalId ? raw.goalId : null,
		waiting: raw.waiting === "owner" || raw.waiting === "track" ? raw.waiting : null,
	};
}

/** The stage note in a focused goal's request context; it changes only when the stage or the wait changes. */
export function trackGoalNote(track: TrackView, goalId: string): string {
	const serves = track.goalId === goalId ? ", which serves this goal" : "";
	const next = track.next.length ? `Next: ${track.next.join(", ")}.` : "This is the final stage.";
	const lines = [
		`[TRACK stage=${track.stage}]`,
		`This thread runs the track "${track.machine}"${serves}. Current stage: ${track.stageTitle}. ${next} Do the goal's work inside this stage and move on with stage_advance; the stage's gate decides, not the goal.`,
	];
	if (track.waiting === "owner") lines.push("The track waits for the owner's approval in the composer. Do not continue goal work: end your turn. The track messages you when the owner answers.");
	else if (track.waiting === "track") lines.push("The track's gate checks or a requested run are in progress. The track messages you with the result.");
	return lines.join("\n");
}

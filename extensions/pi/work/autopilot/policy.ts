/**
 * Reads the track's policy file for this thread (contract: sandy/work/track/POLICY.md), the same file pi/track-guard enforces.
 * The autopilot uses it to refuse a step loadout outside the current stage. Unlike the guard, a missing or unreadable file means "no track": the guard stays the hard bound.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;
/** Who drives the current stage's lease (sandy/work/track/run.ts Driver). */
export type StageDriver = { kind: "agent" } | { kind: "autopilot"; name: string; args?: string };
export type StagePolicy = {
	/** The guard enforces the stage. false: no run, finished or aborted, or the owner paused the guard. */
	active: boolean;
	/** The run is live, also while the owner paused the guard; files that predate it: active. */
	running: boolean;
	stage: string;
	allow: { skills?: string[]; denyTools?: string[] };
	driver: StageDriver;
};

export function policyPath(env: Env): string | null {
	const threadId = env.SANDY_THREAD_ID;
	if (!threadId) return null;
	const dir = env.TRACK_STATE_DIR || join(env.HOME || homedir(), ".local/state/sandy-track");
	return join(dir, "threads", `${threadId}.json`);
}

const isStrings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseDriver(raw: unknown): StageDriver {
	if (!isObject(raw) || raw.kind !== "autopilot" || typeof raw.name !== "string" || !raw.name) return { kind: "agent" };
	return {
		kind: "autopilot",
		name: raw.name,
		...(typeof raw.args === "string" ? { args: raw.args } : {}),
	};
}

/** null when the text is not a version 1 policy. */
export function parseStagePolicy(text: string): StagePolicy | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(raw) || raw.version !== 1 || typeof raw.active !== "boolean") return null;
	const allow = isObject(raw.allow) ? raw.allow : {};
	return {
		active: raw.active,
		running: typeof raw.running === "boolean" ? raw.running : raw.active,
		stage: typeof raw.stage === "string" ? raw.stage : "",
		allow: {
			...(isStrings(allow.skills) ? { skills: allow.skills } : {}),
			...(isStrings(allow.denyTools) ? { denyTools: allow.denyTools } : {}),
		},
		driver: parseDriver(raw.driver),
	};
}

export function readStagePolicy(env: Env = process.env): StagePolicy | null {
	const path = policyPath(env);
	if (path === null) return null;
	try {
		return parseStagePolicy(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
}

/** A denyTools entry matches the tool name exactly or as the suffix after "__", as the guard does. */
const denies = (entry: string, tool: string) => tool === entry || tool.endsWith(`__${entry}`);

/**
 * Why a step's skills or tools fall outside the current stage, or undefined when they fit. autopilot_submit always fits:
 * it only hands the step's value back (the track guard allows it too, sandy/work/track/POLICY.md).
 */
export function loadoutProblem(policy: StagePolicy | null, loadout: { tools?: string[]; skills?: string[] }): string | undefined {
	if (!policy?.active) return undefined;
	const allowed = policy.allow.skills;
	const skills = allowed ? (loadout.skills ?? []).filter((skill) => !allowed.includes(skill)) : [];
	const tools = (loadout.tools ?? []).filter(
		(tool) => !denies("autopilot_submit", tool) && (policy.allow.denyTools ?? []).some((entry) => denies(entry, tool)),
	);
	const problems = [
		skills.length ? `skills ${skills.join(", ")} (allowed: ${allowed!.join(", ") || "none"})` : "",
		tools.length ? `tools ${tools.join(", ")} (denied in this stage)` : "",
	].filter(Boolean);
	return problems.length ? `stage "${policy.stage}" does not allow ${problems.join(" and ")}` : undefined;
}

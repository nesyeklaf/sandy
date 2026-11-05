import { existsSync, linkSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** The host files named before the rename to `context`, each with its new name, under the agent directory. */
const MOVES = [
	{ from: "sandy-context.json", to: "context.json", kind: "file" },
	{ from: "sandy-context", to: "context", kind: "directory" },
] as const;

/** `warning` names a ledger directory left under its old name; the engine goes on in the new one. */
export type MigrationResult =
	| { readonly status: "moved"; readonly moved: readonly string[]; readonly warning?: string }
	| { readonly status: "none"; readonly warning?: string }
	| { readonly status: "conflict"; readonly message: string };

/** A test's hook into the move: `step` is the step about to run. */
type MoveHook = (from: string, to: string, step: "move" | "unlink") => void;

const RELOAD_HINT =
	"A pi process loaded before the rename may still write the old names: reload every loaded pi process on this host with `sandy pi-lifecycle reload`, then merge or remove the old one by hand.";

/**
 * Moves the config file and the ledger directory from their old names to the new ones, once. Both names present is a
 * conflict, never a silent pick; so is an old file that cannot be read. A conflict on the config file stops the start
 * before anything moves: running on the wrong settings is worse than not running. One on the ledger directory, which
 * holds the request ledger and keep-warm signals and no settings, leaves both directories as they are and comes back
 * as a `warning`. A start that loses the race to a parallel one finds the new names in place and goes on; so does
 * one that finds both names on one file, a parallel start between its link and its unlink. The move never replaces: a
 * different file that appeared at the new name after the look is a conflict too, and so is one that replaced the old
 * name during the move.
 *
 * `beforeStep` runs right before each move, and for a file once more between its link and its unlink, so a test can
 * replay a parallel start or an old writer there. `config: false` leaves the config file where it is, for a start that
 * reads its settings from elsewhere; the ledger directory always moves, since other processes on the host read it.
 */
export function migrateHostFiles(agentDir: string, beforeStep: MoveHook = () => {}, { config = true }: { readonly config?: boolean } = {}): MigrationResult {
	const pending: { from: string; to: string; kind: "file" | "directory" }[] = [];
	let warning: string | undefined;
	for (const move of MOVES) {
		if (move.kind === "file" && !config) continue;
		const from = join(agentDir, move.from);
		const to = join(agentDir, move.to);
		// The new name first: seeing the new name and then the old one means both exist. Either a parallel start is
		// between its link and its unlink, both names on one file, or the old name is a second file.
		const hasNew = existsSync(to);
		if (!existsSync(from)) continue;
		let problem: string | undefined;
		if (hasNew) {
			if (oneFile(from, to)) continue;
			problem = `context: both ${from} and ${to} exist. ${RELOAD_HINT}`;
		} else {
			const unreadable = readProblem(from, move.kind);
			if (unreadable === undefined) pending.push({ from, to, kind: move.kind });
			else if (!movedByParallelStart(unreadable, from, to)) {
				const reason = unreadable instanceof Error ? unreadable.message : String(unreadable);
				problem = `context: ${from} cannot be read, so it was not moved to ${to}: ${reason}`;
			}
		}
		if (problem === undefined) continue;
		if (move.kind === "file") return { status: "conflict", message: problem };
		warning = ledgerLeft(problem, to);
	}

	const moved: string[] = [];
	for (const { from, to, kind } of pending) {
		try {
			beforeStep(from, to, "move");
			moveNoClobber(from, to, kind, beforeStep);
			moved.push(`${from} -> ${to}`);
		} catch (error) {
			if (movedByParallelStart(error, from, to)) continue;
			// The link found the new name taken by the old file itself: a parallel start linked it and unlinks the old next.
			if ((error as NodeJS.ErrnoException).code === "EEXIST" && oneFile(from, to)) continue;
			const reason = error instanceof Error ? error.message : String(error);
			const problem =
				existsSync(to) && existsSync(from)
					? `context: both ${from} and ${to} exist. ${RELOAD_HINT}`
					: `context: moving ${from} to ${to} failed: ${reason}. ${RELOAD_HINT}`;
			if (kind === "file") return { status: "conflict", message: problem };
			warning = ledgerLeft(problem, to);
		}
	}
	const extra = warning === undefined ? {} : { warning };
	return moved.length > 0 ? { status: "moved", moved, ...extra } : { status: "none", ...extra };
}

function ledgerLeft(problem: string, to: string): string {
	return `${problem} The request ledger and keep-warm signals go on in ${to}.`;
}

/**
 * Move without replacing what is at `to`. A file is linked to the new name, which fails when the name is taken, and
 * then unlinked from the old one, but only while the old name still leads to the file just linked: an old writer that
 * saved its config by renaming a new file over the old name in between keeps that file, and the start reports both
 * names. The check and the unlink are two steps, so a replacement in the instant between them is still lost; what
 * excludes old writers is the rollout, which reloads every pi process before the new version loads. A directory is
 * renamed: rename refuses a directory that is not empty, on every platform, and on Windows any existing one; an empty
 * directory that appears at the new name in the instant between the look and the move holds nothing to lose.
 */
function moveNoClobber(from: string, to: string, kind: "file" | "directory", beforeStep: MoveHook): void {
	if (kind === "directory") {
		renameSync(from, to);
		return;
	}
	linkSync(from, to);
	beforeStep(from, to, "unlink");
	if (!oneFile(from, to)) throw new Error(`${from} was replaced while it was moved`);
	unlinkSync(from);
}

/** A parallel start moved the old name between this start's look and its read or move. */
function movedByParallelStart(error: unknown, from: string, to: string): boolean {
	return (error as NodeJS.ErrnoException).code === "ENOENT" && existsSync(to) && !existsSync(from);
}

/**
 * Both names lead to one file, or the old name went away after the new one was seen: a parallel start's move in flight
 * or done. Compared by device and inode; bigint keeps Windows' 64-bit file ids exact.
 */
function oneFile(from: string, to: string): boolean {
	let target: { dev: bigint; ino: bigint };
	try {
		target = statSync(to, { bigint: true });
	} catch {
		return false;
	}
	try {
		const source = statSync(from, { bigint: true });
		return source.dev === target.dev && source.ino === target.ino;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

function readProblem(path: string, kind: "file" | "directory"): unknown {
	try {
		if (kind === "file") JSON.parse(readFileSync(path, "utf8"));
		else readdirSync(path);
		return undefined;
	} catch (error) {
		return error;
	}
}

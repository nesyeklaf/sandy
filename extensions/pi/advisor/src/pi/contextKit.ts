import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildSessionProjection } from "@earendil-works/pi-coding-agent";

/**
 * The pieces of pi/context the advisor reuses: its log search and read, its tool schemas and the extension that gives
 * the advisor its own cuts and notebook. pi/context is a sibling unit with its own node_modules, so it is loaded at
 * runtime from the monorepo (or from ADVISOR_CONTEXT_DIR) instead of being compiled into this unit.
 */
export interface ContextKit {
	// The kit crosses a package boundary, so its members are loosely typed on purpose.
	/* eslint-disable @typescript-eslint/no-explicit-any */
	/** Every entry and compaction of a branch as it was written: pi/context's archive, with its own search and read. */
	archiveOf: (branch: readonly unknown[]) => {
		entries: readonly unknown[];
		search: (p: any, signal?: AbortSignal) => Promise<{ text: string }>;
		read: (p: any, signal?: AbortSignal) => Promise<{ text: string }>;
	};
	historySearchParameters: unknown;
	historyReadParameters: unknown;
	createContextExtension: (o?: { configFile?: false }) => (pi: any) => void;
}

export function contextDir(env: Record<string, string | undefined> = process.env): string {
	return env.ADVISOR_CONTEXT_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "context");
}

/** Undefined when pi/context is not there; the advisor then runs without its search tools and context plugin. */
export async function loadContext(dir = contextDir()): Promise<ContextKit | undefined> {
	const src = join(dir, "src");
	if (!existsSync(join(src, "core", "index.ts"))) return undefined;
	try {
		const imp = (p: string): Promise<any> => import(pathToFileURL(join(src, p)).href);
		const [core, ext, session, schemas] = await Promise.all([imp("core/index.ts"), imp("pi/extension.ts"), imp("pi/session.ts"), imp("tools/schemas.ts")]);
		const archiveOf = (branch: readonly unknown[]) => session.SessionTape.read(branch, buildSessionProjection).archive();
		return { ...core, archiveOf, createContextExtension: ext.createContextExtension, historySearchParameters: schemas.historySearchParameters, historyReadParameters: schemas.historyReadParameters };
	} catch {
		return undefined;
	}
}

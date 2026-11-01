import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The pieces of pi/context the advisor reuses: its log search and read, its tool schemas and the extension that gives
 * the advisor its own cuts and notebook. pi/context is a sibling unit with its own node_modules, so it is loaded at
 * runtime from the monorepo (or from ADVISOR_CONTEXT_DIR) instead of being compiled into this unit.
 */
export interface ContextKit {
	// The kit crosses a package boundary, so its members are loosely typed on purpose.
	/* eslint-disable @typescript-eslint/no-explicit-any */
	answerSearch: (pages: any, from: any, p: any, archived: any) => Promise<{ text: string }>;
	newestFirstPages: (entries: any, size: number, cursor?: string) => any;
	newestFirstPagesFrom: (entries: any, id: string) => any;
	readHistory: (entries: any, p: any) => { text: string };
	readBranch: (branch: readonly unknown[]) => { entries: any };
	SCAN_PAGE: number;
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
		const [core, ext, branch, schemas] = await Promise.all([imp("core/index.ts"), imp("pi/extension.ts"), imp("pi/branch.ts"), imp("tools/schemas.ts")]);
		return { ...core, readBranch: branch.readBranch, createContextExtension: ext.createContextExtension, historySearchParameters: schemas.historySearchParameters, historyReadParameters: schemas.historyReadParameters };
	} catch {
		return undefined;
	}
}

import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// pi reads its config directory from PI_CODING_AGENT_DIR, default ~/.pi/agent. Point it at a
// fresh directory before pi loads, so no test reads or writes the user's settings or logins.
process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "context-pi-agent-"));

/**
 * The workspace's pinned pi. Its own dependencies (pi-ai, typebox) are loaded from that
 * installation so the tests share pi's module instances.
 */
const piRoot = realpathSync(
	fileURLToPath(new URL("../../node_modules/@earendil-works/pi-coding-agent", import.meta.url)),
);

if (!existsSync(join(piRoot, "dist", "index.js"))) {
	throw new Error(`pi not found at ${piRoot}; run npm install`);
}

/** Finds a package the way the runtime resolves it from pi: nested under pi (npm) or beside it (Bun's isolated linker). */
function piDependency(name: string): string {
	for (let dir = piRoot; dirname(dir) !== dir; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules", name);
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(`${name} not found next to pi at ${piRoot}`);
}

export const piSdk = (await import(
	pathToFileURL(join(piRoot, "dist", "index.js")).href
)) as typeof import("@earendil-works/pi-coding-agent");

interface FauxModel {
	readonly provider: string;
	readonly id: string;
	readonly api: string;
	readonly baseUrl: string;
	readonly name: string;
	readonly reasoning: boolean;
	readonly input: ("text" | "image")[];
	readonly cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	readonly contextWindow: number;
	readonly maxTokens: number;
}

export interface FauxContext {
	readonly systemPrompt?: string;
	readonly messages: readonly { readonly role: string; readonly content?: unknown }[];
}

type FauxFactory = (
	context: FauxContext,
	options: Record<string, unknown> | undefined,
	state: unknown,
	model: { id: string; provider: string },
) => unknown;

export interface FauxRegistration {
	readonly api: string;
	readonly models: FauxModel[];
	getModel(): FauxModel;
	setResponses(responses: FauxFactory[]): void;
	unregister(): void;
}

export interface PiAiCompat {
	registerFauxProvider(options: {
		models: { id: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number }[];
		tokensPerSecond?: number;
	}): FauxRegistration;
	fauxAssistantMessage(content: unknown, options?: { stopReason?: string; errorMessage?: string }): unknown;
	fauxText(text: string): unknown;
	fauxToolCall(name: string, args: Record<string, unknown>, options?: { id?: string }): unknown;
}

export const typebox = (await import(
	pathToFileURL(join(piDependency("typebox"), "build", "index.mjs")).href
)) as typeof import("typebox");

export const piAi = (await import(
	pathToFileURL(join(piDependency("@earendil-works/pi-ai"), "dist", "compat.js")).href
)) as PiAiCompat;

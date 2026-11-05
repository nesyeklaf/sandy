import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { KEEP_WARM_KIND } from "../../src/core/kinds.ts";
import { createContextExtension } from "../../src/pi/extension.ts";
import { FakeAnthropic, type FakeRequest } from "./anthropic-server.ts";
import { piSdk } from "./pi.ts";

/*
 * A waiting session stays warm with a one-token side request: pi-ai's real Anthropic client talks to a local stand-in
 * that models the prompt cache, so each test sees the exact bytes a ping carries and what the cache read for it. The
 * clock is the extension's own (`now`): a test moves it instead of waiting for a cache to expire.
 */

export const TTL_MS = 300_000;
export const START = 1_000_000;
/** The answer ends this long after its request started. */
export const ANSWER_MS = 90_000;

export type Entry = { type: string; customType?: string; data?: Record<string, unknown> };

export interface WaitingOptions {
	model?: string;
	later?: (pi: ExtensionAPI) => void;
	settings?: Record<string, unknown>;
	config?: Record<string, unknown>;
	/** Another pi process's view of the same session: its file, a server it does not own, and the signal both read. */
	shared?: { manager: ReturnType<typeof piSdk.SessionManager.open>; server: Pick<FakeAnthropic, "baseUrl" | "requests" | "responder" | "stop">; signalFile: string };
}

export async function waitingSession(options: WaitingOptions = {}) {
	const server = (options.shared?.server ?? (await new FakeAnthropic().start())) as FakeAnthropic;
	const dir = mkdtempSync(join(tmpdir(), "context-warm-"));
	const ledgerFile = join(dir, "ledger.jsonl");
	const signalFile = options.shared?.signalFile ?? join(dir, "keep-warm", "thread.json");
	let clock = START;
	server.responder = () => {
		clock += ANSWER_MS;
		return [{ type: "text", text: "done" }];
	};
	const probe = (pi: ExtensionAPI) => pi.registerProvider("anthropic", { baseUrl: server.baseUrl, apiKey: "test-key" });
	const context = createContextExtension({
		configFile: false,
		ledgerFile,
		now: () => clock,
		keepWarm: { file: signalFile, intervalMs: 10 },
		config: { historian: { enabled: false }, ...options.config },
	});
	const create: Parameters<typeof piSdk.createAgentSessionRuntime>[0] = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await piSdk.createAgentSessionServices({
			cwd,
			agentDir: dir,
			settingsManager: piSdk.SettingsManager.inMemory(options.settings ?? {}),
			resourceLoaderOptions: {
				extensionFactories: [probe, context, ...(options.later ? [options.later] : [])],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const model = services.modelRuntime.getModel("anthropic", options.model ?? "claude-sonnet-5-5");
		const session = await piSdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: model as never, thinkingLevel: "low" });
		return { ...session, services, diagnostics: services.diagnostics };
	};
	const runtime = await piSdk.createAgentSessionRuntime(create, { cwd: dir, agentDir: dir, sessionManager: options.shared?.manager ?? piSdk.SessionManager.inMemory() });
	await runtime.session.bindExtensions({});
	const entries = () => runtime.session.sessionManager.getEntries() as unknown as Entry[];
	const isPing = (request: FakeRequest) => request.body.max_tokens === 1;
	const pings = () => server.requests.filter(isPing);
	/** The session expects its next prompt at `until`, `at` ms into the test's clock. */
	const expectPrompt = (until: number) => {
		mkdirSync(dirname(signalFile), { recursive: true });
		writeFileSync(signalFile, JSON.stringify({ until }));
	};
	const settle = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
	const waitFor = async (done: () => boolean) => {
		for (let wait = 0; wait < 100 && !done(); wait++) await settle(10);
	};
	return {
		server,
		runtime,
		entries,
		pings,
		expectPrompt,
		settle,
		waitFor,
		ledger: () => readFileSync(ledgerFile, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>),
		clock: (value: number) => {
			clock = value;
		},
		removeSignal: () => rmSync(signalFile, { force: true }),
		warmRecords: () => entries().filter((entry) => entry.type === "custom" && entry.customType === KEEP_WARM_KIND).map((entry) => entry.data as Record<string, unknown>),
		messages: () => entries().filter((entry) => entry.type === "message" || entry.type === "custom_message").length,
		close: async () => {
			await runtime.dispose();
			await server.stop();
		},
	};
}


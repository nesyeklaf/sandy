/**
 * Live run against a real model: pi's runtime, the real provider, real tools, the real historian.
 *
 *   node --experimental-strip-types test/live/run.ts [--fast] [--thinking=low] [--summary=tokens] [--idle=seconds]
 *
 * The model is fixed to openai/gpt-6-luna. The only credential is OPENAI_API_KEY from the
 * environment; pi runs with a throwaway config directory, so no login, settings or extensions of
 * the user are read. Without the key, and always in CI, the run is skipped. The watermark is set
 * low so a short session produces several cuts. Writes a JSON report and keeps the session file.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextExtensionOptions } from "../../src/pi/extension.ts";

const MODEL = "openai/gpt-6-luna";
if (process.env.CI) {
	console.log("test:live skipped: it never runs in CI.");
	process.exit(0);
}
if (!process.env.OPENAI_API_KEY) {
	console.log(`test:live skipped: OPENAI_API_KEY is not set. Export it to run against ${MODEL}.`);
	process.exit(0);
}
// Loaded only after the checks: support/pi.ts gives pi its throwaway config directory.
const { piSdk } = await import("../support/pi.ts");

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const fast = args.includes("--fast");
const flag = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.split("=")[1];
// Before the recall questions: wait past the cache lifetime.
const idleSeconds = Number(flag("idle") ?? 0);
const coldMin = Number(flag("cold-min") ?? 8_000);
// A small summary budget makes the historian condense its oldest records during the run.
const summaryBudget = Number(flag("summary") ?? 3_000);
const watermark = Number(args.find((arg) => arg.startsWith("--watermark="))?.split("=")[1] ?? 30_000);
const thinking = (args.find((arg) => arg.startsWith("--thinking="))?.split("=")[1] ?? "low") as
	| "off"
	| "low"
	| "medium";

const root = mkdtempSync(join(tmpdir(), "sandy-live-"));
const workspace = join(root, "workspace");
const agentDir = join(root, "agent");
mkdirSync(workspace, { recursive: true });
mkdirSync(agentDir, { recursive: true });

// A workspace of reports. Each holds one code the agent is asked about, buried in filler.
const CODES = [
	"amber-falcon-17",
	"cobalt-otter-42",
	"crimson-lynx-08",
	"jade-heron-63",
	"onyx-badger-29",
	"teal-marten-91",
	"ivory-crane-55",
	"rust-bison-74",
	"plum-gecko-36",
	"sage-walrus-12",
];
for (const [index, code] of CODES.entries()) {
	const filler = Array.from(
		{ length: 260 },
		(_, line) =>
			`entry ${line}: subsystem ${(line * 7 + index) % 13} reported nominal throughput ${(line * 37 + index * 11) % 997} ops/s`,
	);
	filler.splice(130 + index, 0, `RELEASE CODE: ${code}`);
	writeFileSync(join(workspace, `report-${index + 1}.txt`), `${filler.join("\n")}\n`);
}

const CONSTRAINT = "Answer in English, and never edit files whose name starts with report-.";
const prompts: { text: string; expect?: RegExp; label: string }[] = [
	{
		label: "constraint",
		text: `Ground rules for this whole session: ${CONSTRAINT} Also remember that the project codename is ORCHID-LANTERN. Confirm briefly.`,
	},
	...CODES.map((code, index) => ({
		label: `read-${index + 1}`,
		text: `Read report-${index + 1}.txt completely with the read tool (it is about 260 lines) and tell me its release code. Reply with the code only.`,
		expect: new RegExp(code),
	})),
	{
		label: "recall-early",
		text: "Without reading any report file again: what was the release code of report-1.txt, and what is the project codename? If it is no longer in your context, use your tools to find it. Reply with both.",
		expect: new RegExp(`${CODES[0]}[\\s\\S]*ORCHID-LANTERN|ORCHID-LANTERN[\\s\\S]*${CODES[0]}`),
	},
	{
		label: "recall-rules",
		text: "Which files did I forbid you to edit at the start of this session? Answer in one sentence.",
		expect: /report-/,
	},
	{
		// Never mentioned in any answer: only the archived tool output has it.
		label: "recall-detail",
		text: "Without reading the file again: in report-2.txt, what throughput did entry 200 report? Use your tools if it is not in your context. Reply with the number only.",
		expect: /\b432\b/,
	},
	{
		label: "recall-late",
		text: "Without reading the file again: what was the release code of report-7.txt? Reply with the code only.",
		expect: new RegExp(CODES[6] ?? ""),
	},
	{
		label: "recall-mid",
		text: "Without reading the file again: what was the release code of report-4.txt? Reply with the code only.",
		expect: new RegExp(CODES[3] ?? ""),
	},
];

const ledgerFile = join(root, "ledger.jsonl");
const options: ContextExtensionOptions = {
	configFile: false,
	ledgerFile,
	config: {
		watermarkTokens: watermark,
		keepRecentTokens: 8_000,
		maskedTokens: 3_000,
		pinnedUserTokens: 2_000,
		summaryTokens: summaryBudget,
		coldCutMinTokens: coldMin,
		historian: {
			enabled: !args.includes("--no-historian"),
			chunkMinTokens: 4_000,
			chunkMaxTokens: 16_000,
			maxOutputTokens: 2_000,
		},
	},
};
(globalThis as { __sandyContextTest?: ContextExtensionOptions }).__sandyContextTest = options;

interface RequestLog {
	prompt: string;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	ms: number;
}
const requests: RequestLog[] = [];
const cutTimings: { kind: string; ms: number }[] = [];
let currentPrompt = "";
let requestStart = 0;

const observer = (pi: ExtensionAPI) => {
	pi.on("before_provider_request", (event) => {
		requestStart = Date.now();
		if (!fast || typeof event.payload !== "object" || event.payload === null) return undefined;
		return { ...(event.payload as Record<string, unknown>), service_tier: "priority" };
	});
	pi.on("message_end", (event) => {
		const message = event.message as {
			role?: string;
			usage?: { input?: number; cacheRead?: number; cacheWrite?: number; output?: number };
		};
		if (message.role !== "assistant" || !message.usage) return undefined;
		requests.push({
			prompt: currentPrompt,
			input: message.usage.input ?? 0,
			cacheRead: message.usage.cacheRead ?? 0,
			cacheWrite: message.usage.cacheWrite ?? 0,
			output: message.usage.output ?? 0,
			ms: Date.now() - requestStart,
		});
		return undefined;
	});
	let compactStart = 0;
	pi.on("session_before_compact", () => {
		compactStart = Date.now();
		return undefined;
	});
	pi.on("session_compact", (event) => {
		cutTimings.push({ kind: `compact:${event.reason}`, ms: Date.now() - compactStart });
	});
};

// The auth file sits in the run's own directory and stays empty: pi takes the key from OPENAI_API_KEY.
const modelRuntime = await piSdk.ModelRuntime.create({
	authPath: join(agentDir, "auth.json"),
	modelsPath: join(agentDir, "models.json"),
});
const [provider = "", modelId = ""] = MODEL.split("/");
const model =
	modelRuntime.getModel?.(provider, modelId) ?? new piSdk.ModelRegistry(modelRuntime).find(provider, modelId);
if (!model) throw new Error(`model ${MODEL} not found`);

const loader = new piSdk.DefaultResourceLoader({
	cwd: workspace,
	agentDir,
	additionalExtensionPaths: [join(here, "..", "fixtures", "extension-under-test.ts")],
	extensionFactories: [observer],
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await loader.reload();
const { session } = await piSdk.createAgentSession({
	cwd: workspace,
	agentDir,
	modelRuntime,
	resourceLoader: loader,
	model,
	thinkingLevel: thinking,
	sessionManager: piSdk.SessionManager.create(workspace, join(root, "sessions")),
	// Pi refuses a manual compaction unless history older than its own keepRecentTokens exists;
	// the small live watermark needs a matching small value, or cold and model cuts never run.
	settingsManager: piSdk.SettingsManager.inMemory({ cacheWarming: "off", compaction: { keepRecentTokens: 2_000 } }),
});
await session.bindExtensions({});

const results: { label: string; ok: boolean | null; answer: string; ms: number; tools: string[] }[] = [];
const started = Date.now();
try {
	for (const prompt of prompts) {
		if (prompt.label === "recall-early") {
			if (idleSeconds > 0) {
				console.log(`idle ${idleSeconds}s`);
				await new Promise((resolve) => setTimeout(resolve, idleSeconds * 1_000));
			}
		}
		currentPrompt = prompt.label;
		const before = session.sessionManager.getEntries().length;
		const t0 = Date.now();
		await session.prompt(prompt.text);
		const answer = session.getLastAssistantText() ?? "";
		const tools = session.sessionManager
			.getEntries()
			.slice(before)
			.flatMap((entry) => {
				if (entry.type !== "message") return [];
				const message = entry.message as { role?: string; toolName?: string };
				return message.role === "toolResult" && message.toolName ? [message.toolName] : [];
			});
		const last = session.sessionManager.getEntries().at(-1);
		const failed = last?.type === "message" ? (last.message as { errorMessage?: string }).errorMessage : undefined;
		// A provider error such as a rejected key fails every later prompt the same way.
		if (failed) throw new Error(`${MODEL}: ${failed}`);
		const ok = prompt.expect ? prompt.expect.test(answer) : null;
		results.push({ label: prompt.label, ok, answer: answer.slice(0, 300), ms: Date.now() - t0, tools });
		console.log(
			`${prompt.label}: ${ok === null ? "-" : ok ? "ok" : "WRONG"} ${Date.now() - t0}ms [${tools.join(",")}] ${answer.replace(/\s+/g, " ").slice(0, 120)}`,
		);
	}
} finally {
	const entries = session.sessionManager.getEntries();
	const cuts = entries.flatMap((entry) =>
		entry.type === "compaction" && (entry.details as { sandyContext?: unknown } | undefined)?.sandyContext
			? [
					{
						reason: (
							entry.details as { sandyContext: { reason: string; blockTokens: number; archivedEntries: number } }
						).sandyContext,
					},
				]
			: [],
	);
	const summaryData = entries.flatMap((entry) =>
		entry.type === "custom" && entry.customType === "sandy-context.summary"
			? [entry.data as { condenseUsage?: unknown }]
			: [],
	);
	const summaries = summaryData.length;
	const condensations = summaryData.filter((data) => data.condenseUsage !== undefined).length;
	const ledger = (() => {
		try {
			return readFileSync(ledgerFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { class: string; reason?: string; at?: unknown });
		} catch {
			return [];
		}
	})();
	const classes: Record<string, number> = {};
	for (const record of ledger) classes[record.class] = (classes[record.class] ?? 0) + 1;
	const prompt = requests.reduce((sum, r) => sum + r.input + r.cacheRead + r.cacheWrite, 0);
	const cached = requests.reduce((sum, r) => sum + r.cacheRead, 0);
	const report = {
		model: MODEL,
		fast,
		thinking,
		seconds: Math.round((Date.now() - started) / 1000),
		results,
		cuts: cuts.map((cut) => cut.reason),
		cutTimings,
		summaries,
		condensations,
		lastSummary: summaryData.at(-1),
		ledger: { classes, breaks: ledger.filter((r) => r.class !== "continued" && r.class !== "first") },
		cache: { promptTokens: prompt, cacheReadTokens: cached, ratio: prompt ? cached / prompt : null },
		requests,
		sessionFile: session.sessionManager.getSessionFile(),
		root,
	};
	writeFileSync(join(root, "report.json"), JSON.stringify(report, null, 2));
	console.log(`report: ${join(root, "report.json")}`);
	session.dispose();
}

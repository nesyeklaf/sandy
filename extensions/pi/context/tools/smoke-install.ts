/**
 * Smoke test of the packed plugin in a clean pi install: `npm run smoke [-- --pi <version>] [--keep]`.
 *
 * It packs this unit, installs pi (the version under test) into one disposable directory and the tarball into
 * another, with no peer dependencies, so the plugin can only get pi's packages from pi's own extension loader. A
 * disposable agent directory names the installed plugin in `settings.json`. Then a child process, started with a
 * minimal environment (no BB variables, no home directory of the user), loads it through pi's real loader and:
 *
 *   - resumes a session written before the rename (old notebook, a foreign compaction summary) and an old
 *     `sandy-context.json`, which moves to `context.json`;
 *   - runs `history_search`, `history_read` and `notebook` as the model calls them, and `/context`;
 *   - registers no `sandy` alias;
 *   - rejects a bad `context.json` when the extension loads.
 *
 * This file imports nothing from `src/`: whatever it sees comes from the installed tarball. Exit code 0 passes.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

interface Check {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
}

const unitDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_NAME = "pi-context";
/** Names a tarball must not carry: test data, secrets, thread data, the dev checkout's installs and sessions. */
const FORBIDDEN_IN_PACK = [/^test\//, /(^|\/)\.env/, /(^|\/)node_modules\//, /\.jsonl$/, /thread-storage/, /(^|\/)sessions?\//, /package-lock\.json$/];

const MARKER = "ZEBRAFACT-7731";
const FOREIGN = "FOREIGNSUMMARY-4410";
const OLD_NOTEBOOK = "GOAL: ship slice two OLDNOTEBOOK-9902";

if (process.argv[2] === "child") {
	await runChild(process.argv[3] as "good" | "bad", JSON.parse(process.argv[4] ?? "{}") as ChildInput);
} else {
	process.exitCode = await runParent(process.argv.slice(2));
}

/* ------------------------------------------------------------------ parent: pack, install, start the children */

async function runParent(args: string[]): Promise<number> {
	const piIndex = args.indexOf("--pi");
	const manifest = JSON.parse(readFileSync(join(unitDir, "package.json"), "utf8")) as { devDependencies: Record<string, string> };
	const piVersion = piIndex >= 0 ? (args[piIndex + 1] ?? "") : (manifest.devDependencies["@earendil-works/pi-coding-agent"] ?? "");
	const keep = args.includes("--keep");
	const work = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "context-smoke-"));
	const checks: Check[] = [];
	const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
	console.log(`smoke: pi ${piVersion}, work dir ${work}`);
	try {
		const tarball = pack(work, check);
		const host = join(work, "host");
		const plugin = join(work, "plugin");
		install(host, [`@earendil-works/pi-coding-agent@${piVersion}`, `@earendil-works/pi-ai@${piVersion}`], []);
		// No peers: nothing next to the plugin could answer its import of pi, typebox or pi-ai except pi's loader.
		install(plugin, [tarball], ["--legacy-peer-deps", "--omit=dev"]);
		const installed = join(plugin, "node_modules", PACKAGE_NAME);
		check("the tarball installed with its entry point", existsSync(join(installed, "index.ts")), installed);
		check("no pi package sits beside the plugin", !existsSync(join(plugin, "node_modules", "@earendil-works")), "installed with --legacy-peer-deps");
		const installedVersion = (JSON.parse(readFileSync(join(host, "node_modules", "@earendil-works", "pi-coding-agent", "package.json"), "utf8")) as { version: string }).version;
		check(`the host pi is ${piVersion}`, installedVersion === piVersion, installedVersion);

		for (const scenario of ["good", "bad"] as const) {
			const agentDir = join(work, `agent-${scenario}`);
			mkdirSync(agentDir, { recursive: true });
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [installed] }));
			const input: ChildInput = { work, host, plugin: installed, agentDir };
			const run = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url), "child", scenario, JSON.stringify(input)], {
				cwd: work,
				encoding: "utf8",
				timeout: 120_000,
				// A minimal environment: no SANDY_* or BB_* variable, no user HOME, no provider key.
				env: { PATH: process.env.PATH ?? "", HOME: join(work, "home"), TMPDIR: work, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" },
			});
			const last = run.stdout.trim().split("\n").at(-1) ?? "";
			try {
				checks.push(...(JSON.parse(last) as Check[]));
			} catch {
				check(`${scenario} scenario produced a result`, false, `exit ${run.status}\n${run.stdout}\n${run.stderr}`);
			}
			if (run.status !== 0 && !checks.some((one) => !one.ok)) check(`${scenario} scenario exit code`, false, String(run.status));
		}
	} catch (error) {
		check("harness", false, error instanceof Error ? error.message : String(error));
	} finally {
		if (!keep) rmSync(work, { recursive: true, force: true });
	}
	for (const one of checks) console.log(`${one.ok ? "PASS" : "FAIL"} ${one.name}${one.detail && (!one.ok || one.detail.length < 120) ? ` (${one.detail})` : ""}`);
	const failed = checks.filter((one) => !one.ok).length;
	console.log(failed === 0 ? `smoke passed: ${checks.length} checks` : `smoke FAILED: ${failed} of ${checks.length} checks`);
	return failed === 0 ? 0 : 1;
}

function sh(command: string, args: string[], cwd: string): string {
	const run = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" } });
	if (run.status !== 0) throw new Error(`${command} ${args.join(" ")} failed (${run.status}): ${run.stderr || run.stdout}`);
	return run.stdout;
}

/** `npm pack` of this unit into the work dir; checks the file list against what an install needs and what stays private. */
function pack(work: string, check: (name: string, ok: boolean, detail?: string) => void): string {
	const destination = join(work, "pack");
	mkdirSync(destination);
	const packed = JSON.parse(sh("npm", ["pack", "--json", "--pack-destination", destination], unitDir)) as { filename: string; files: { path: string }[] }[];
	const files = (packed[0]?.files ?? []).map((file) => file.path);
	const forbidden = files.filter((path) => FORBIDDEN_IN_PACK.some((pattern) => pattern.test(path)));
	const missing = ["index.ts", "package.json", "src/pi/extension.ts"].filter((path) => !files.includes(path));
	check("the pack holds what the install needs", missing.length === 0, `${files.length} files; missing: ${missing.join(", ") || "none"}`);
	check("the pack holds nothing private", forbidden.length === 0, forbidden.join(", ") || "no test data, .env, sessions or lockfile");
	return join(destination, packed[0]?.filename ?? "");
}

function install(dir: string, packages: string[], flags: string[]): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke-" + dirname(dir).length, private: true }));
	sh("npm", ["install", "--ignore-scripts", "--no-save", ...flags, ...packages], dir);
}

/* --------------------------------------------------------------- child: the installed plugin in pi's own loader */

interface ChildInput {
	readonly work: string;
	readonly host: string;
	readonly plugin: string;
	readonly agentDir: string;
}

type PiSdk = typeof import("@earendil-works/pi-coding-agent");
type PiAi = typeof import("@earendil-works/pi-ai/compat");

async function runChild(scenario: "good" | "bad", input: ChildInput): Promise<void> {
	const checks: Check[] = [];
	const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });
	const leaked = Object.keys(process.env).filter((name) => name.startsWith("SANDY_") || name.startsWith("BB_"));
	check(`${scenario}: the child sees no SANDY or BB environment`, leaked.length === 0, leaked.join(", "));
	try {
		const sdkRoot = join(input.host, "node_modules", "@earendil-works");
		const sdk = (await import(pathToFileURL(join(sdkRoot, "pi-coding-agent", "dist", "index.js")).href)) as PiSdk;
		const piAi = (await import(pathToFileURL(join(sdkRoot, "pi-ai", "dist", "compat.js")).href)) as PiAi;
		if (scenario === "bad") await badConfig(sdk, input, check);
		else await goodInstall(sdk, piAi, input, check);
	} catch (error) {
		check(`${scenario}: the scenario ran`, false, error instanceof Error ? (error.stack ?? error.message) : String(error));
	}
	console.log(JSON.stringify(checks));
}

/** The loader's own account of the extensions it loaded or refused. */
async function load(sdk: PiSdk, input: ChildInput, extensionFactories: ((pi: never) => void)[] = []) {
	const services = await sdk.createAgentSessionServices({
		cwd: join(input.work, "project"),
		agentDir: input.agentDir,
		resourceLoaderOptions: { extensionFactories: extensionFactories as never, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
	});
	return { services, loaded: services.resourceLoader.getExtensions() };
}

async function badConfig(sdk: PiSdk, input: ChildInput, check: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	mkdirSync(join(input.work, "project"), { recursive: true });
	writeFileSync(join(input.agentDir, "context.json"), JSON.stringify({ watermarkTokenz: 100_000 }));
	const { loaded } = await load(sdk, input);
	const failure = loaded.errors.find((one) => one.path.startsWith(input.plugin));
	check("bad config: the installed plugin is refused at load", failure !== undefined, JSON.stringify(loaded.errors.map((one) => one.path)));
	check("bad config: the error names the field", /pi-context: invalid configuration[\s\S]*unknown field watermarkTokenz/.test(failure?.error ?? ""), failure?.error ?? "no error");
	check("bad config: nothing of the plugin registered", !loaded.extensions.some((one) => one.path.startsWith(input.plugin)), `${loaded.extensions.length} extensions loaded`);
}

async function goodInstall(sdk: PiSdk, piAi: PiAi, input: ChildInput, check: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
	const project = join(input.work, "project");
	const sessionDir = join(input.work, "sessions");
	mkdirSync(project, { recursive: true });

	// What a host holds from before the rename: the old config file and ledger directory.
	const oldConfig = JSON.stringify({ watermarkTokens: 150_000 });
	writeFileSync(join(input.agentDir, "sandy-context.json"), oldConfig);
	mkdirSync(join(input.agentDir, "sandy-context"));
	writeFileSync(join(input.agentDir, "sandy-context", "ledger.jsonl"), '{"old":"ledger line"}\n');

	// A session as the version before the rename left it: an old notebook, then a checkpoint pi itself wrote.
	const written = sdk.SessionManager.create(project, sessionDir);
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	let clock = Date.UTC(2026, 9, 1);
	const say = (role: "user" | "assistant", text: string) =>
		written.appendMessage(
			(role === "user"
				? { role, content: [{ type: "text", text }], timestamp: ++clock }
				: { role, content: [{ type: "text", text }], api: "faux", provider: "faux", model: "faux-1", usage, stopReason: "stop", timestamp: ++clock }) as never,
		);
	say("user", `Question 0: what is the deployment code? ${"word ".repeat(40)}`);
	say("assistant", `Answer 0: the deployment code is ${MARKER}. ${"fact ".repeat(40)}`);
	written.appendCustomEntry("sandy-context.notebook", { text: OLD_NOTEBOOK });
	const kept = say("user", `Question 1: and the rollback plan? ${"word ".repeat(40)}`);
	say("assistant", `Answer 1: roll back by redeploying the last tag. ${"fact ".repeat(40)}`);
	written.appendCompaction(`Summary by pi: ${FOREIGN} the user asked about deployments.`, kept, 5_000, undefined, false);
	say("user", "Question 2: anything else?");
	say("assistant", "Answer 2: no.");
	const file = written.getSessionFile() as string;
	const resumed = sdk.SessionManager.open(file, sessionDir);

	// The faux model's script: search, read the notebook, read the hit, say we are done.
	const faux = piAi.registerFauxProvider({ models: [{ id: "faux-main", reasoning: false, contextWindow: 200_000, maxTokens: 4_096 }] });
	faux.setResponses([
		() => piAi.fauxAssistantMessage([piAi.fauxToolCall("history_search", { query: MARKER })]),
		() => piAi.fauxAssistantMessage([piAi.fauxToolCall("notebook", {})]),
		(context: { messages: { role: string }[] }) => {
			const id = /#([0-9a-f]{8})/.exec(JSON.stringify(context.messages.filter((one) => one.role === "toolResult")))?.[1] ?? "missing";
			return piAi.fauxAssistantMessage([piAi.fauxToolCall("history_read", { id })]);
		},
		() => piAi.fauxAssistantMessage([piAi.fauxToolCall("history_search", { query: FOREIGN })]),
		() => piAi.fauxAssistantMessage("done"),
		...Array.from({ length: 20 }, () => () => piAi.fauxAssistantMessage("ok")),
	] as never);
	const model = faux.getModel();
	const provider = (pi: { registerProvider(name: string, config: never): void }) =>
		pi.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((one) => ({ id: one.id, name: one.name, api: one.api, reasoning: one.reasoning, input: one.input, cost: one.cost, contextWindow: one.contextWindow, maxTokens: one.maxTokens })),
		} as never);

	const notices: string[] = [];
	const quiet = () => undefined;
	const ui = { notify: (text: string) => notices.push(text), setStatus: quiet, setWidget: quiet, setFooter: quiet, setHeader: quiet, setTitle: quiet, setWorkingMessage: quiet, setEditorText: quiet } as never;
	let extensionPaths: string[] = [];
	const create: Parameters<typeof sdk.createAgentSessionRuntime>[0] = async ({ sessionManager, sessionStartEvent }) => {
		const { services, loaded } = await load(sdk, input, [provider as never]);
		extensionPaths = loaded.extensions.map((one) => one.path);
		return { ...(await sdk.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: model as never })), services, diagnostics: services.diagnostics };
	};
	const runtime = await sdk.createAgentSessionRuntime(create, { cwd: project, agentDir: input.agentDir, sessionManager: resumed });
	const { session } = runtime;
	check("good: pi's loader loaded the installed plugin", extensionPaths.some((path) => path.startsWith(input.plugin)), extensionPaths.join(", "));
	await session.bindExtensions({ uiContext: ui });

	const tools = session.extensionRunner.getAllRegisteredTools().map((one) => one.definition.name);
	const commands = session.extensionRunner.getRegisteredCommands().map((one) => one.name);
	check("good: the tools and the command are registered", ["history_search", "history_read", "notebook"].every((name) => tools.includes(name)) && commands.includes("context"), `tools ${tools.join(",")}; commands ${commands.join(",")}`);
	const aliases = [...tools, ...commands].filter((name) => /sandy/i.test(name));
	check("good: no Sandy alias is registered", aliases.length === 0, aliases.join(", ") || "no tool or command named sandy");

	check("good: the old config file moved to context.json", !existsSync(join(input.agentDir, "sandy-context.json")) && readFileSync(join(input.agentDir, "context.json"), "utf8") === oldConfig, readdirSync(input.agentDir).join(", "));
	const ledger = join(input.agentDir, "context", "ledger.jsonl");
	check("good: the old ledger directory moved to context/", !existsSync(join(input.agentDir, "sandy-context")) && existsSync(ledger) && readFileSync(ledger, "utf8").includes("ledger line"), readdirSync(input.agentDir).join(", "));
	check("good: the first start told what moved", notices.some((text) => /moved the files named before the rename/.test(text)), notices[0] ?? "no notice");

	await session.prompt("find the deployment code");
	const results = new Map<string, string>();
	const searches: string[] = [];
	for (const entry of session.sessionManager.getEntries()) {
		if (entry.type !== "message" || (entry.message as { role: string }).role !== "toolResult") continue;
		const message = entry.message as unknown as { toolName: string; content: { type: string; text?: string }[]; isError?: boolean };
		const text = (message.isError ? "ERROR " : "") + message.content.map((block) => block.text ?? "").join("\n");
		results.set(message.toolName, text);
		if (message.toolName === "history_search") searches.push(text);
	}
	check("good: history_search finds a line of the old session", (searches[0] ?? "").includes(MARKER), (searches[0] ?? "no result").slice(0, 100));
	check("good: the notebook is the old notebook", (results.get("notebook") ?? "").includes(OLD_NOTEBOOK), (results.get("notebook") ?? "no result").slice(0, 100));
	check("good: history_read opens the hit", (results.get("history_read") ?? "").includes(MARKER) && !(results.get("history_read") ?? "").startsWith("ERROR"), (results.get("history_read") ?? "no result").slice(0, 100));

	await session.prompt("/context");
	const status = notices.find((text) => text.startsWith("Prompt:")) ?? "";
	check("good: /context reports the old notebook", new RegExp(`notebook ${Buffer.byteLength(OLD_NOTEBOOK)} bytes`).test(status), status.split("\n")[1] ?? "no status");
	check("good: /context counts the old log", /Log: \d+ entries/.test(status), status.split("\n").find((line) => line.startsWith("Log:")) ?? "no status");
	check("good: the foreign summary stays searchable in the archive", (searches[1] ?? "").includes(FOREIGN), (searches[1] ?? "no result").slice(0, 100));
	const summaryRecords = session.sessionManager.getEntries().filter((entry) => entry.type === "custom" && /^(sandy-)?context\.summary$/.test(entry.customType));
	check("good: the foreign summary was not rewritten into one of ours", summaryRecords.length === 0, `${summaryRecords.length} summary records`);
	await runtime.dispose();
	faux.unregister();
}

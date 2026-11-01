/**
 * Fix autopilot: an autopilot in which the model only writes code.
 *
 *   /autopilot fix <test file relative to cwd>      or the tool: autopilot({name: "fix", args: "<test file>"})
 *
 * Everything except the edit itself is code: gathering context, choosing the thinking level, validating and applying
 * the edit, running the checks, retrying, committing and the final question. The model gets one tool, submit_patch,
 * and no session; a call without it counts as a failed attempt. Every model answer is logged to .fix-run.json (or
 * FIX_LOG); FIX_REPLAY=<run.json> replays the logged answers instead of calling the model. Test and check commands
 * come from FIX_TEST ({file} placeholder) and FIX_CHECK, else from package.json. Returns the run record.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const THINKING = "high" as const;
const MAX_ATTEMPTS = 3;
const MAX_CONTEXT_FILES = 24;
const MAX_CONTEXT_BYTES = 200_000;

type Edit = { path: string; old: string; new: string };
type Patch = { edits: Edit[]; summary: string };
type Thinking = { requested: unknown; blocks: number; chars: number; redacted: number };
type Attempt = { attempt: number; source: "model" | "replay"; patch?: Patch; rejected?: string; check?: { code: number; tail: string }; ms: number; usage?: unknown; thinking?: Thinking; stopReason?: string };

const SUBMIT_PATCH = {
	name: "submit_patch",
	description: "Submit the fix as exact text replacements. Each old must occur exactly once in its file.",
	parameters: {
		type: "object",
		additionalProperties: false,
		required: ["edits", "summary"],
		properties: {
			summary: { type: "string", description: "One line, imperative, for the commit message" },
			edits: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					additionalProperties: false,
					required: ["path", "old", "new"],
					properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
				},
			},
		},
	},
};

const SYSTEM = [
	"You fix one failing test by editing source code.",
	"You cannot run anything or read more files. Everything you get is in the user message.",
	"Answer only by calling submit_patch once. Edit only the files you were given. Do not edit the test.",
	"Fix the defect where it is. Do not work around it in a caller, for example by adding a second check on top of a wrong one.",
].join("\n");

function sh(cmd: string, cwd: string) {
	const r = spawnSync("bash", ["-lc", cmd], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const tail = (s: string, n = 4000) => (s.length > n ? s.slice(-n) : s);
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** The repo's own packages: name to entry file, from each workspace package.json's exports "." or main. */
function workspacePackages(root: string): Map<string, string> {
	const found = new Map<string, string>();
	const ls = sh("git ls-files '*package.json'", root).out.split("\n").filter((p) => p && !p.includes("node_modules"));
	for (const p of ls) {
		try {
			const pkg = JSON.parse(readFileSync(join(root, p), "utf8"));
			const dot = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
			const entry = typeof dot === "string" ? dot : (dot?.import ?? dot?.default ?? pkg.main);
			if (pkg.name && typeof entry === "string") found.set(pkg.name, resolve(root, dirname(p), entry));
		} catch {}
	}
	return found;
}

/** Repo files a failure names, such as the frames of a stack trace, in the order they appear. */
function filesInOutput(output: string, root: string): string[] {
	const out: string[] = [];
	for (const m of output.matchAll(/((?:\/|\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\.[cm]?[jt]sx?)(?::\d+)/g)) {
		const abs = resolve(root, m[1]);
		if (!relative(root, abs).startsWith("..") && !abs.includes("node_modules") && existsSync(abs)) out.push(abs);
	}
	return out;
}

/**
 * Deterministic context: the test, the repo files its failure names, then every import, breadth-first: relative
 * imports and imports of the repo's own packages. Stops at MAX_CONTEXT_FILES files or MAX_CONTEXT_BYTES.
 */
function relatedFiles(testFile: string, root: string, failure: string): string[] {
	const packages = workspacePackages(root);
	const seen = new Set<string>();
	let bytes = 0;
	const queue = [resolve(root, testFile), ...filesInOutput(failure, root)];
	while (queue.length > 0 && seen.size < MAX_CONTEXT_FILES) {
		const file = queue.shift()!;
		if (seen.has(file) || !existsSync(file)) continue;
		const text = readFileSync(file, "utf8");
		if (bytes + text.length > MAX_CONTEXT_BYTES) continue;
		bytes += text.length;
		seen.add(file);
		for (const m of text.matchAll(/(?:import|export)[^"']*?from\s+["']([^"']+)["']/g)) {
			const spec = m[1];
			const target = spec.startsWith(".") ? resolve(dirname(file), spec) : packages.get(spec);
			if (target && !relative(root, target).startsWith("..")) queue.push(target);
		}
	}
	return [...seen].map((f) => relative(root, f)).sort();
}

/** The test and check commands: FIX_TEST (with {file}) and FIX_CHECK from the environment, else from package.json. */
function commands(root: string): { test: (file: string) => string; check: string } {
	let pkg: any = {};
	try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch {}
	const deps = { ...pkg.dependencies, ...pkg.devDependencies };
	const vp = "vite-plus" in deps;
	const bun = existsSync(join(root, "bun.lock")) || existsSync(join(root, "bun.lockb"));
	const run = bun ? "bun run" : "npm run";
	const testTemplate = process.env.FIX_TEST ?? (vp ? "bun vp test {file}" : "vitest" in deps ? "npx vitest run {file}" : bun ? "bun test {file}" : "node --test {file}");
	const vpTask = vp && ["vite.config.ts", "vite.config.mts", "vite.config.js"].some((c) => existsSync(join(root, c)) && /\btypecheck\s*:/.test(readFileSync(join(root, c), "utf8")));
	const check = process.env.FIX_CHECK ?? (vpTask ? "bun vp run typecheck" : pkg.scripts?.typecheck ? `${run} typecheck` : "");
	return { test: (file) => testTemplate.replaceAll("{file}", JSON.stringify(file)), check };
}

function contextMessage(testFile: string, files: string[], failure: string, root: string, history: string[]) {
	const parts = [`Failing test: ${testFile}`, "Test output:\n```\n" + tail(failure) + "\n```"];
	for (const f of files) parts.push(`File ${f}:\n\`\`\`ts\n${readFileSync(join(root, f), "utf8")}\n\`\`\``);
	if (history.length > 0) parts.push("Earlier attempts failed:\n" + history.join("\n---\n"));
	return parts.join("\n\n");
}

/** Forces the one tool where the API allows it; pi-ai's provider-neutral toolChoice only knows auto and none. */
function forceTool(payload: any, api: string) {
	if (!payload || typeof payload !== "object") return undefined;
	if (api.startsWith("openai")) return { ...payload, tool_choice: { type: "function", name: SUBMIT_PATCH.name } };
	return undefined; // Anthropic rejects a forced tool together with extended thinking; the code checks instead.
}

async function askModel(ctx: any, text: string): Promise<{ patch?: Patch; error?: string; usage?: unknown; thinking?: Thinking; stopReason?: string }> {
	const model = ctx.model;
	if (!model) return { error: "no model selected" };
	let requested: unknown = null;
	const stream = ctx.modelRegistry.streamSimple(
		model,
		{ systemPrompt: SYSTEM, tools: [SUBMIT_PATCH], messages: [{ role: "user", content: text, timestamp: Date.now() }] },
		{ reasoning: THINKING, onPayload: (p: any) => { requested = p?.thinking ?? p?.reasoning ?? p?.reasoning_effort ?? null; return forceTool(p, String(model.api)); } },
	);
	const msg = await stream.result();
	const blocks = msg.content.filter((c: any) => c.type === "thinking");
	const seen: Thinking = { requested, blocks: blocks.length, chars: blocks.reduce((n: number, b: any) => n + String(b.thinking ?? "").length, 0), redacted: blocks.filter((b: any) => b.redacted).length };
	const meta = { usage: msg.usage, thinking: seen, stopReason: msg.stopReason };
	if (msg.stopReason === "error") return { error: `model error: ${msg.errorMessage}`, ...meta };
	const calls = msg.content.filter((c: any) => c.type === "toolCall" && c.name === SUBMIT_PATCH.name);
	if (calls.length !== 1) return { error: `expected one submit_patch call, got ${calls.length}`, ...meta };
	const args = calls[0].arguments as Patch;
	if (!Array.isArray(args?.edits) || typeof args.summary !== "string") return { error: "submit_patch arguments do not match the schema", ...meta };
	return { patch: args, ...meta };
}

/** Validates every edit against the allowed files before touching the disk. */
function applyPatch(patch: Patch, allowed: Set<string>, root: string, testFile: string): string | undefined {
	const next = new Map<string, string>();
	for (const e of patch.edits) {
		const rel = isAbsolute(e.path) ? relative(root, e.path) : e.path;
		if (!allowed.has(rel)) return `edit outside the given files: ${e.path}`;
		if (rel === testFile) return "edit touches the test";
		const current = next.get(rel) ?? readFileSync(join(root, rel), "utf8");
		const count = current.split(e.old).length - 1;
		if (count !== 1) return `old text occurs ${count} times in ${rel}`;
		next.set(rel, current.replace(e.old, () => e.new));
	}
	for (const [rel, text] of next) writeFileSync(join(root, rel), text);
	return undefined;
}

export default async function fix(args: unknown, api: { ctx: any }) {
	const ctx = api.ctx;
	const root = ctx.cwd ?? process.cwd();
	const testFile = String(typeof args === "string" ? args : ((args as any)?.test ?? "")).trim();
	const { test, check: checkCmd } = commands(root);
	const run: { test: string; model: string; thinking: string; files: string[]; commands: { test: string; check: string }; attempts: Attempt[]; outcome?: string; commit?: string; choice?: string } = {
		test: testFile, model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none", thinking: THINKING, files: [], commands: { test: test(testFile), check: checkCmd }, attempts: [],
	};
	const log = process.env.FIX_LOG ?? join(root, ".fix-run.json");
	const save = () => writeFileSync(log, JSON.stringify(run, null, 2));
	const replay: Attempt[] | undefined = process.env.FIX_REPLAY ? JSON.parse(readFileSync(process.env.FIX_REPLAY, "utf8")).attempts : undefined;
	const say = (m: string) => (ctx.hasUI ? ctx.ui.notify(m, "info") : console.error(`[fix] ${m}`));
	const end = (outcome: string) => { run.outcome = outcome; save(); say(outcome); return run; };

	if (!testFile || !existsSync(join(root, testFile))) return { error: `no such test file: ${testFile}` };
	if (sh("git diff --quiet && git diff --cached --quiet", root).code !== 0) return { error: "working tree is not clean; refusing to start" };

	const first = sh(test(testFile), root);
	if (first.code === 0) return end("already green");

	run.files = relatedFiles(testFile, root, stripAnsi(first.out));
	const allowed = new Set(run.files);
	const history: string[] = [];
	let failure = stripAnsi(first.out);

	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		const started = Date.now();
		const logged = replay?.[attempt - 1];
		// A logged attempt is replayed; past the end of the log the model takes over.
		const answer: Awaited<ReturnType<typeof askModel>> = logged
			? logged.patch ? { patch: logged.patch } : { error: logged.rejected ?? "nothing logged" }
			: await askModel(ctx, contextMessage(testFile, run.files, failure, root, history));
		const a: Attempt = { attempt, source: logged ? "replay" : "model", patch: answer.patch, ms: 0, usage: answer.usage, thinking: answer.thinking, stopReason: answer.stopReason };
		run.attempts.push(a);
		const rejected = answer.error ?? applyPatch(answer.patch!, allowed, root, testFile);
		if (rejected) {
			a.rejected = rejected; a.ms = Date.now() - started; history.push(`Attempt ${attempt} rejected: ${rejected}`); save();
			say(`attempt ${attempt}: rejected (${rejected})`);
			continue;
		}
		const check = sh(checkCmd ? `${test(testFile)} && ${checkCmd}` : test(testFile), root);
		a.check = { code: check.code, tail: tail(stripAnsi(check.out), 1500) };
		a.ms = Date.now() - started;
		if (check.code === 0) {
			sh(`git commit -qam ${JSON.stringify(`fix: ${answer.patch!.summary}`)}`, root);
			run.commit = sh("git rev-parse --short HEAD", root).out.trim();
			return end(`green after ${attempt} attempt(s), commit ${run.commit}`);
		}
		sh("git checkout -- .", root);
		failure = stripAnsi(check.out);
		history.push(`Attempt ${attempt} applied ${JSON.stringify(answer.patch)} and the checks failed:\n${tail(failure, 2000)}`);
		save();
		say(`attempt ${attempt}: checks red`);
	}
	if (ctx.hasUI) run.choice = (await ctx.ui.select(`${MAX_ATTEMPTS} attempts red. What now?`, ["Stop", "I take over"])) ?? "nothing";
	return end(`red after ${MAX_ATTEMPTS} attempts`);
}

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, vi } from "vitest";
import { createContextExtension } from "../src/pi/extension.ts";
import { checkHost, detectCapabilities, type HostCapabilities, REQUIRED_CAPABILITIES } from "../src/pi/host.ts";
import { type FakePi, fakePi } from "./support/host.ts";
import { openRuntime } from "./support/lifecycle.ts";
import { piAi, piSdk } from "./support/pi.ts";

const all = Object.fromEntries(Object.keys(REQUIRED_CAPABILITIES).map((name) => [name, true])) as {
	-readonly [name in keyof HostCapabilities]: boolean;
};

const settings = (content: string): string => {
	const file = join(mkdtempSync(join(tmpdir(), "context-config-")), "settings.json");
	writeFileSync(file, content);
	return file;
};

/** Load the extension on a recording pi; returns what was registered, or the error that stopped the load. */
function load(options: Parameters<typeof createContextExtension>[0], pi: FakePi = fakePi()) {
	let error: Error | undefined;
	try {
		createContextExtension({ ledgerFile: false, keepWarm: false, ...options })(pi.api);
	} catch (thrown) {
		error = thrown as Error;
	}
	return { pi, error };
}

describe("the host check", () => {
	it("accepts a host with every required capability", () => {
		assert.deepEqual(checkHost(all), { supported: true });
	});

	it("names each missing capability in a readable message", () => {
		const result = checkHost({ ...all, sessionProjection: false, eventBus: false });
		assert.ok(!result.supported);
		assert.deepEqual(result.missing, ["eventBus", "sessionProjection"]);
		assert.match(result.message, /needs pi 1\.3\.0 or newer/);
		assert.match(result.message, /the extension event bus \(pi\.events\)/);
		assert.match(result.message, /buildSessionProjection/);
	});

	it("detects capabilities from the objects pi hands over, not from a version", () => {
		const host = { getAgentDir: () => "", buildSessionProjection: () => ({}) };
		assert.deepEqual(detectCapabilities(fakePi().api, host), all);
		const detected = detectCapabilities(fakePi(["registerTool", "events"]).api, { getAgentDir: host.getAgentDir });
		assert.equal(detected.tools, false);
		assert.equal(detected.eventBus, false);
		assert.equal(detected.sessionProjection, false);
		assert.equal(detected.hooks, true);
	});
});

describe("a setup that cannot work stops the load before anything is registered", () => {
	const failures: [string, Parameters<typeof createContextExtension>[0], RegExp][] = [
		["a pi without a required capability", { configFile: false }, /pi-context needs pi 1\.3\.0 or newer; this pi lacks: custom session entries/],
		["an unknown field", { configFile: settings('{"watermarkToken":100000}') }, /unknown field watermarkToken/],
		["a wrong type", { configFile: settings('{"watermarkTokens":"100000"}') }, /watermarkTokens must be a number/],
		["a malformed model reference", { configFile: settings('{"historian":{"model":"claude-haiku"}}') }, /historian\.model must be a provider\/model reference/],
		["contradictory budgets", { configFile: settings('{"watermarkTokens":30000}') }, /must stay below watermarkTokens/],
		["a settings file that is not JSON", { configFile: settings("{ nope") }, /cannot be read/],
		["bad options from the embedder", { configFile: false, config: { maskedTokens: -1 } }, /maskedTokens must be a positive number/],
	];

	for (const [name, options, message] of failures) {
		it(name, () => {
			const missingCapability = name.startsWith("a pi without");
			const { pi, error } = load(options, missingCapability ? fakePi(["appendEntry"]) : fakePi());
			assert.ok(error, "expected the load to throw");
			assert.match(error.message, message);
			assert.deepEqual(pi.registered, []);
		});
	}

	it("lists every problem of a settings file in one error", () => {
		const { error } = load({ configFile: settings('{"watermarkTokens":30000,"extra":1,"historian":{"model":"bad"}}') });
		assert.ok(error);
		assert.match(error.message, /extra/);
		assert.match(error.message, /historian\.model/);
		assert.match(error.message, /watermarkTokens/);
	});

	it("loads with no settings file", () => {
		const { pi, error } = load({ configFile: join(tmpdir(), "context-no-such-dir", "settings.json") });
		assert.equal(error, undefined);
		assert.ok(pi.registered.includes("tool:history_search"));
	});
});

describe("a configured historian model is checked when the session starts", () => {
	const sessionContext = (known: string[]) => {
		const calls: string[] = [];
		let shutdowns = 0;
		return {
			calls,
			shutdowns: () => shutdowns,
			ctx: {
				modelRegistry: {
					find: (provider: string, id: string) => {
						calls.push(`${provider}/${id}`);
						return known.includes(`${provider}/${id}`) ? { provider, id } : undefined;
					},
				},
				shutdown: () => {
					shutdowns++;
				},
				// Any operational session_start handler would read the session first; this context has none.
				sessionManager: undefined,
			},
		};
	};
	const start = (pi: FakePi, ctx: unknown) => {
		for (const { event, handler } of pi.handlers) if (event === "session_start") handler({ reason: "startup" }, ctx);
	};

	it("fails startup on a typo, shuts pi down, and leaves tools and hooks inert", () => {
		const { pi, error } = load({ configFile: settings('{"historian":{"model":"anthropic/claude-haiku-typo"}}') });
		assert.equal(error, undefined);
		const session = sessionContext(["anthropic/claude-haiku"]);
		assert.throws(
			() => start(pi, session.ctx),
			/pi-context: historian\.model "anthropic\/claude-haiku-typo" is not a model this pi knows/,
		);
		assert.equal(session.shutdowns(), 1);
		// The operational handlers ran after the bootstrap one and did nothing (they would have thrown on the session).
		assert.doesNotThrow(() => pi.handlers.filter(({ event }) => event === "turn_end").forEach(({ handler }) => handler({}, session.ctx)));
		assert.throws(() => pi.tools.get("notebook")?.execute("id", {}, undefined, undefined, session.ctx), /historian\.model/);
	});

	it("starts when the configured models exist", () => {
		const { pi } = load({
			configFile: settings('{"historian":{"model":"anthropic/claude-haiku","fallbackModel":"openai-codex/gpt-6-luna"}}'),
		});
		const session = sessionContext(["anthropic/claude-haiku", "openai-codex/gpt-6-luna"]);
		const bootstrap = pi.handlers.find(({ event }) => event === "session_start");
		assert.ok(bootstrap);
		assert.doesNotThrow(() => bootstrap.handler({ reason: "startup" }, session.ctx));
		assert.deepEqual(session.calls, ["anthropic/claude-haiku", "openai-codex/gpt-6-luna"]);
		assert.equal(session.shutdowns(), 0);
	});

	it("asks the registry for nothing when no historian model is set", () => {
		const { pi } = load({ configFile: false });
		const session = sessionContext([]);
		const bootstrap = pi.handlers.find(({ event }) => event === "session_start");
		assert.ok(bootstrap);
		assert.doesNotThrow(() => bootstrap.handler({ reason: "startup" }, session.ctx));
		assert.deepEqual(session.calls, []);
	});
});

describe(`the extension in the real pi runtime (pi ${piSdk.VERSION})`, () => {
	async function realLoad(options: Parameters<typeof createContextExtension>[0]) {
		const dir = mkdtempSync(join(tmpdir(), "context-host-"));
		const loader = new piSdk.DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			extensionFactories: [createContextExtension({ ledgerFile: false, keepWarm: false, ...options })],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		return loader.getExtensions();
	}

	it(`loads, registering the three tools and the command on pi ${piSdk.VERSION}`, async () => {
		const { extensions, errors } = await realLoad({ configFile: false });
		assert.deepEqual(errors, []);
		const [loaded] = extensions;
		assert.ok(loaded);
		assert.deepEqual([...loaded.tools.keys()].sort(), ["history_read", "history_search", "notebook"]);
		assert.ok(loaded.commands.has("context"));
		assert.ok(loaded.handlers.has("session_start"));
	});

	it(`refuses a bad settings file on pi ${piSdk.VERSION}, with nothing registered`, async () => {
		const { extensions, errors } = await realLoad({ configFile: settings('{"historian":{"model":"typo"}}') });
		assert.equal(errors.length, 1);
		assert.match(errors[0]?.error ?? "", /historian\.model must be a provider\/model reference/);
		assert.equal(extensions.length, 0);
	});

	it(`reports an unknown historian model and shuts down at session start on pi ${piSdk.VERSION}`, async () => {
		const dir = mkdtempSync(join(tmpdir(), "context-host-"));
		const loader = new piSdk.DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			extensionFactories: [
				createContextExtension({ configFile: false, ledgerFile: false, keepWarm: false, config: { historian: { model: "nope/typo" } } }),
			],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		const modelRuntime = await piSdk.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json") });
		const { session } = await piSdk.createAgentSession({
			cwd: dir,
			agentDir: dir,
			modelRuntime,
			resourceLoader: loader,
			sessionManager: piSdk.SessionManager.inMemory(),
		});
		const reported: { event: string; error: string }[] = [];
		let shutdowns = 0;
		await session.bindExtensions({
			shutdownHandler: () => {
				shutdowns++;
			},
			onError: (error: { event: string; error: string }) => reported.push(error),
		} as never);
		assert.equal(shutdowns, 1);
		assert.equal(reported.length, 1);
		assert.equal(reported[0]?.event, "session_start");
		assert.match(reported[0]?.error ?? "", /historian\.model "nope\/typo" is not a model this pi knows/);
	});

	for (const mode of ["text", "json"] as const) {
		it(`sends no prompt to the provider after an unknown historian model, in print mode ${mode} on pi ${piSdk.VERSION}`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "context-host-"));
			const { runtime, faux } = await openRuntime({
				dir,
				manager: piSdk.SessionManager.inMemory(dir) as never,
				trace: [],
				options: { configFile: false, ledgerFile: false, keepWarm: false, config: { historian: { model: "nope/typo" } } },
			});
			let requests = 0;
			faux.setResponses(
				Array.from({ length: 4 }, () => () => {
					requests++;
					return piAi.fauxAssistantMessage("ok");
				}),
			);
			const errors: string[] = [];
			const stderr = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
				errors.push(args.join(" "));
			});
			// Print mode writes its answer, or json events, to stdout and waits for each write's callback.
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(((_chunk: unknown, encoding?: unknown, done?: unknown) => {
				const callback = typeof encoding === "function" ? encoding : done;
				if (typeof callback === "function") callback();
				return true;
			}) as never);
			try {
				await piSdk.runPrintMode(runtime, { mode, initialMessage: "hello", messages: ["again"] });
			} finally {
				stderr.mockRestore();
				stdout.mockRestore();
				faux.unregister();
			}
			assert.equal(requests, 0, "the provider got a request");
			assert.ok(
				errors.some((line) => /historian\.model "nope\/typo" is not a model this pi knows.*not sent/s.test(line)),
				"the refusal names the error: " + errors.join(" | "),
			);
		});
	}
});

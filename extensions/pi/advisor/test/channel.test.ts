import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { CUT_REQUEST_CHANNEL as CONTEXT_LISTENS_ON, TASK_DONE_KIND } from "../../context/src/core/kinds.ts";
import { openRuntime } from "../../context/test/support/lifecycle.ts";
import { piSdk } from "../../context/test/support/pi.ts";
import advisorExtension, { CUT_REQUEST_CHANNEL } from "../src/pi/extension.ts";

describe("the cut request to pi/context", () => {
	it("goes out on the channel pi/context listens on", () => {
		expect(CUT_REQUEST_CHANNEL).toBe(CONTEXT_LISTENS_ON);
		expect(CUT_REQUEST_CHANNEL).toBe("context.cut-request");
	});

	const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SANDY_THREAD_ID: process.env.SANDY_THREAD_ID };
	afterEach(() => {
		for (const [name, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});

	it("reaches pi/context when a task closes: both extensions in one pi, the request lands in the session log", async () => {
		const dir = mkdtempSync(join(tmpdir(), "advisor-channel-"));
		// The advisor reads ~/.pi/agent/advisor.json: a home of its own, with everything that would call a model off.
		process.env.HOME = dir;
		process.env.USERPROFILE = dir;
		process.env.SANDY_THREAD_ID = "thr_channel";
		mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
		writeFileSync(
			join(dir, ".pi", "agent", "advisor.json"),
			JSON.stringify({ gate: { enabled: false }, review: { enabled: false }, agent: { enabled: false } }),
		);
		// The ideas state the advisor polls: IDEA-1 open at the start, closed after the first run.
		const states = [["IDEA-1"], []].map((open) =>
			JSON.stringify({
				thread: "thr_channel",
				intent: { id: "intent_1", title: "T", state: "proposed", doneWhen: "" },
				idea: null,
				tasks: open.map((key) => ({ key, title: key, status: "todo" })),
				notes: [],
			}),
		);
		const exec = async () => ({ code: 0, stdout: states.length > 1 ? (states.shift() as string) : (states[0] as string), stderr: "", killed: false });
		const advisor = (pi: ExtensionAPI) =>
			advisorExtension(
				new Proxy(pi, {
					get: (target, key) => {
						if (key === "exec") return exec;
						const value = Reflect.get(target, key);
						return typeof value === "function" ? value.bind(target) : value;
					},
				}),
			);
		const { runtime, faux } = await openRuntime({
			dir,
			manager: piSdk.SessionManager.inMemory(dir) as never,
			trace: [],
			extensions: [advisor],
			options: { configFile: false, ledgerFile: false, keepWarm: false },
		});
		try {
			await runtime.session.bindExtensions({});
			await runtime.session.prompt("do the task");
			const requests = () =>
				runtime.session.sessionManager
					.getBranch()
					.filter((entry: SessionEntry) => entry.type === "custom" && entry.customType === TASK_DONE_KIND);
			for (let tries = 0; tries < 100 && requests().length === 0; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
			expect(requests().map((entry) => (entry as { data?: unknown }).data)).toEqual([{ closed: ["IDEA-1"] }]);
		} finally {
			await runtime.dispose();
			faux.unregister();
		}
	});
});

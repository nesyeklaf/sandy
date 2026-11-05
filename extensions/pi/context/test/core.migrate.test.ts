import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";
import { loadConfig } from "../src/pi/config.ts";
import { createContextExtension } from "../src/pi/extension.ts";
import { type MigrationResult, migrateHostFiles } from "../src/pi/migrate.ts";
import { fakePi } from "./support/host.ts";

// Every test works in its own temp directory; none reads or writes the user's agent directory.
const agentDir = () => mkdtempSync(join(tmpdir(), "context-migrate-"));
const OWNER_CONFIG = `{\n  "watermarkTokens": 100000,\n  "deferMarginTokens": 40000,\n  "hardCapTokens": 200000\n}\n`;
const LEDGER_LINE = '{"at":1,"kind":"request"}\n';

function oldFiles(dir: string): void {
	writeFileSync(join(dir, "sandy-context.json"), OWNER_CONFIG);
	mkdirSync(join(dir, "sandy-context", "keep-warm"), { recursive: true });
	writeFileSync(join(dir, "sandy-context", "ledger.jsonl"), LEDGER_LINE);
	writeFileSync(join(dir, "sandy-context", "keep-warm", "s1.json"), '{"until":1}');
}

describe("migrateHostFiles", () => {
	it("moves the old config file and ledger directory, keeping the owner's 100k watermark", () => {
		const dir = agentDir();
		oldFiles(dir);
		const result = migrateHostFiles(dir);
		assert.equal(result.status, "moved");
		assert.equal(existsSync(join(dir, "sandy-context.json")), false);
		assert.equal(existsSync(join(dir, "sandy-context")), false);
		assert.equal(readFileSync(join(dir, "context.json"), "utf8"), OWNER_CONFIG);
		assert.equal(readFileSync(join(dir, "context", "ledger.jsonl"), "utf8"), LEDGER_LINE);
		assert.equal(readFileSync(join(dir, "context", "keep-warm", "s1.json"), "utf8"), '{"until":1}');
		const config = loadConfig(join(dir, "context.json"), undefined);
		assert.ok(!("configErrors" in config));
		assert.equal(config.watermarkTokens, 100_000);
	});
	it("moves either one alone", () => {
		const fileOnly = agentDir();
		writeFileSync(join(fileOnly, "sandy-context.json"), OWNER_CONFIG);
		assert.equal(migrateHostFiles(fileOnly).status, "moved");
		assert.equal(readFileSync(join(fileOnly, "context.json"), "utf8"), OWNER_CONFIG);
		const dirOnly = agentDir();
		mkdirSync(join(dirOnly, "sandy-context"));
		writeFileSync(join(dirOnly, "sandy-context", "ledger.jsonl"), LEDGER_LINE);
		assert.equal(migrateHostFiles(dirOnly).status, "moved");
		assert.equal(readFileSync(join(dirOnly, "context", "ledger.jsonl"), "utf8"), LEDGER_LINE);
	});
	it("leaves new files alone and reports nothing to do", () => {
		const dir = agentDir();
		writeFileSync(join(dir, "context.json"), OWNER_CONFIG);
		mkdirSync(join(dir, "context"));
		writeFileSync(join(dir, "context", "ledger.jsonl"), LEDGER_LINE);
		assert.deepEqual(migrateHostFiles(dir), { status: "none" });
		assert.equal(readFileSync(join(dir, "context.json"), "utf8"), OWNER_CONFIG);
		assert.deepEqual(migrateHostFiles(agentDir()), { status: "none" });
	});
	it("refuses when the old and the new config file both exist, moves nothing and names the reload command", () => {
		const dir = agentDir();
		oldFiles(dir);
		writeFileSync(join(dir, "context.json"), "{}");
		const result = migrateHostFiles(dir);
		assert.equal(result.status, "conflict");
		if (result.status !== "conflict") return;
		assert.match(result.message, /sandy pi-lifecycle reload/);
		assert.match(result.message, /sandy-context\.json/);
		assert.equal(readFileSync(join(dir, "sandy-context.json"), "utf8"), OWNER_CONFIG);
		assert.equal(readFileSync(join(dir, "sandy-context", "ledger.jsonl"), "utf8"), LEDGER_LINE);
		assert.equal(existsSync(join(dir, "context")), false);
	});
	it("warns when the old and the new ledger directory both exist, leaves both and still moves the config", () => {
		const dir = agentDir();
		oldFiles(dir);
		mkdirSync(join(dir, "context"));
		const result = migrateHostFiles(dir);
		assert.equal(result.status, "moved");
		if (result.status !== "moved") return;
		assert.deepEqual(result.moved, [`${join(dir, "sandy-context.json")} -> ${join(dir, "context.json")}`]);
		assert.match(result.warning ?? "", /sandy-context\b.*sandy pi-lifecycle reload/);
		assert.equal(readFileSync(join(dir, "context.json"), "utf8"), OWNER_CONFIG);
		assert.equal(readFileSync(join(dir, "sandy-context", "ledger.jsonl"), "utf8"), LEDGER_LINE);
		assert.equal(existsSync(join(dir, "context", "ledger.jsonl")), false);
	});
	it("refuses an unreadable old config and moves nothing, not even the ledger directory", () => {
		const dir = agentDir();
		oldFiles(dir);
		chmodSync(join(dir, "sandy-context.json"), 0o000);
		try {
			const result = migrateHostFiles(dir);
			assert.equal(result.status, "conflict");
			if (result.status === "conflict") assert.match(result.message, /cannot be read/);
			assert.equal(existsSync(join(dir, "context.json")), false);
			assert.equal(existsSync(join(dir, "context")), false);
			assert.equal(existsSync(join(dir, "sandy-context", "ledger.jsonl")), true);
		} finally {
			chmodSync(join(dir, "sandy-context.json"), 0o600);
		}
	});
	it("refuses an old config that is not JSON and moves nothing", () => {
		const dir = agentDir();
		oldFiles(dir);
		writeFileSync(join(dir, "sandy-context.json"), "{ watermarkTokens: 100000");
		assert.equal(migrateHostFiles(dir).status, "conflict");
		assert.equal(existsSync(join(dir, "context.json")), false);
		assert.equal(existsSync(join(dir, "context")), false);
	});
	it("continues when a parallel start moved the files between its look and its move", () => {
		const dir = agentDir();
		oldFiles(dir);
		let winner: ReturnType<typeof migrateHostFiles> | undefined;
		const loser = migrateHostFiles(dir, () => {
			winner ??= migrateHostFiles(dir);
		});
		assert.equal(winner?.status, "moved");
		assert.deepEqual(loser, { status: "none" });
		assert.equal(readFileSync(join(dir, "context.json"), "utf8"), OWNER_CONFIG);
		assert.equal(readFileSync(join(dir, "context", "ledger.jsonl"), "utf8"), LEDGER_LINE);
	});
	it("refuses, replacing nothing, when an old writer recreated a name a parallel start had just moved", () => {
		const dir = agentDir();
		oldFiles(dir);
		const RECREATED = '{"watermarkTokens": 5}\n';
		let winner: ReturnType<typeof migrateHostFiles> | undefined;
		const loser = migrateHostFiles(dir, () => {
			if (winner) return;
			winner = migrateHostFiles(dir);
			// An old process writes its config under the old name again before this start's move runs.
			writeFileSync(join(dir, "sandy-context.json"), RECREATED);
		});
		assert.equal(winner?.status, "moved");
		assert.equal(loser.status, "conflict");
		if (loser.status === "conflict") assert.match(loser.message, /sandy pi-lifecycle reload/);
		assert.equal(readFileSync(join(dir, "context.json"), "utf8"), OWNER_CONFIG, "the migrated config survives");
		assert.equal(readFileSync(join(dir, "sandy-context.json"), "utf8"), RECREATED, "the old file stays for the owner");
		assert.equal(readFileSync(join(dir, "context", "ledger.jsonl"), "utf8"), LEDGER_LINE);
	});

	it("goes on when a parallel start looks while this one is between its link and its unlink", () => {
		const dir = agentDir();
		writeFileSync(join(dir, "sandy-context.json"), OWNER_CONFIG);
		let parallel: ReturnType<typeof migrateHostFiles> | undefined;
		const mover = migrateHostFiles(dir, (_from, _to, step) => {
			if (step === "unlink") parallel ??= migrateHostFiles(dir);
		});
		assert.deepEqual(parallel, { status: "none" });
		assert.equal(mover.status, "moved");
		assert.equal(readFileSync(join(dir, "context.json"), "utf8"), OWNER_CONFIG);
		assert.equal(existsSync(join(dir, "sandy-context.json")), false);
	});

	it("keeps an old writer's config that replaced the old name between the link and the unlink, and reports a conflict", () => {
		const dir = agentDir();
		writeFileSync(join(dir, "sandy-context.json"), OWNER_CONFIG);
		const REPLACED = '{"watermarkTokens": 110000}\n';
		const result = migrateHostFiles(dir, (from, _to, step) => {
			if (step !== "unlink") return;
			// An old process saves its config the atomic way: a temp file renamed over the old name.
			writeFileSync(join(dir, "new-config"), REPLACED);
			renameSync(join(dir, "new-config"), from);
		});
		assert.equal(result.status, "conflict");
		if (result.status === "conflict") assert.match(result.message, /sandy pi-lifecycle reload/);
		assert.equal(readFileSync(join(dir, "sandy-context.json"), "utf8"), REPLACED, "the replacement stays for the owner");
		assert.equal(readFileSync(join(dir, "context.json"), "utf8"), OWNER_CONFIG);
	});

	it("goes on when a parallel start linked the new name between this one's look and its link", () => {
		const dir = agentDir();
		writeFileSync(join(dir, "sandy-context.json"), OWNER_CONFIG);
		let linked = false;
		const late = migrateHostFiles(dir, (from, to, step) => {
			if (step !== "move" || linked) return;
			// The parallel start links the old file to the new name and has not yet unlinked the old one.
			linkSync(from, to);
			linked = true;
		});
		assert.deepEqual(late, { status: "none" });
		unlinkSync(join(dir, "sandy-context.json"));
		assert.equal(readFileSync(join(dir, "context.json"), "utf8"), OWNER_CONFIG);
	});

	it("lets parallel processes start together: each name moves once, all run, nothing is lost", async () => {
		const dir = agentDir();
		oldFiles(dir);
		const module = fileURLToPath(new URL("../src/pi/migrate.ts", import.meta.url));
		const startAt = Date.now() + 400;
		const script = `import { migrateHostFiles } from ${JSON.stringify(module)};
while (Date.now() < ${startAt});
process.stdout.write(JSON.stringify(migrateHostFiles(${JSON.stringify(dir)})));`;
		const run = () =>
			new Promise<string>((resolve, reject) => {
				const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
				let out = "";
				let err = "";
				child.stdout.on("data", (chunk) => (out += chunk));
				child.stderr.on("data", (chunk) => (err += chunk));
				child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err))));
			});
		const results = (await Promise.all([run(), run(), run(), run()])).map((out) => JSON.parse(out) as MigrationResult);
		const shown = JSON.stringify(results);
		assert.ok(results.every(({ status }) => status !== "conflict"), shown);
		// The file and the directory move independently: one start may move both, or two starts one each.
		const moved = results.flatMap((result) => (result.status === "moved" ? result.moved : [])).sort();
		assert.deepEqual(
			moved,
			[
				`${join(dir, "sandy-context")} -> ${join(dir, "context")}`,
				`${join(dir, "sandy-context.json")} -> ${join(dir, "context.json")}`,
			],
			shown,
		);
		assert.equal(readFileSync(join(dir, "context.json"), "utf8"), OWNER_CONFIG);
		assert.equal(readFileSync(join(dir, "context", "ledger.jsonl"), "utf8"), LEDGER_LINE);
	});
	it("refuses the next start after an old process wrote its config again following the move", () => {
		const dir = agentDir();
		oldFiles(dir);
		assert.equal(migrateHostFiles(dir).status, "moved");
		// A pi process loaded before the update still writes under the old name.
		writeFileSync(join(dir, "sandy-context.json"), OWNER_CONFIG);
		const result = migrateHostFiles(dir);
		assert.equal(result.status, "conflict");
		if (result.status === "conflict") assert.match(result.message, /sandy pi-lifecycle reload/);
	});
	it("warns the next start, and goes on, after an old process wrote its ledger again following the move", () => {
		const dir = agentDir();
		oldFiles(dir);
		assert.equal(migrateHostFiles(dir).status, "moved");
		// A pi process loaded before the update still writes under the old name.
		mkdirSync(join(dir, "sandy-context"), { recursive: true });
		appendFileSync(join(dir, "sandy-context", "ledger.jsonl"), LEDGER_LINE);
		const result = migrateHostFiles(dir);
		assert.equal(result.status, "none");
		if (result.status === "none") assert.match(result.warning ?? "", /sandy pi-lifecycle reload/);
		assert.equal(readFileSync(join(dir, "sandy-context", "ledger.jsonl"), "utf8"), LEDGER_LINE);
		assert.equal(readFileSync(join(dir, "context", "ledger.jsonl"), "utf8"), LEDGER_LINE);
	});
});

describe("the extension moves the host files when it loads", () => {
	const saved = process.env.PI_CODING_AGENT_DIR;
	afterEach(() => {
		process.env.PI_CODING_AGENT_DIR = saved;
	});
	const load = (dir: string) => {
		process.env.PI_CODING_AGENT_DIR = dir;
		const pi = fakePi();
		createContextExtension({ ledgerFile: false, keepWarm: false })(pi.api);
		return pi;
	};

	it("leaves the host's config file alone for a start given its own, and still moves the ledger directory", () => {
		for (const configFile of [false, "/nonexistent/own-context.json"] as const) {
			const dir = agentDir();
			oldFiles(dir);
			process.env.PI_CODING_AGENT_DIR = dir;
			createContextExtension({ configFile, ledgerFile: false, keepWarm: false })(fakePi().api);
			assert.equal(readFileSync(join(dir, "sandy-context.json"), "utf8"), OWNER_CONFIG, String(configFile));
			assert.equal(existsSync(join(dir, "context.json")), false, String(configFile));
			assert.equal(readFileSync(join(dir, "context", "ledger.jsonl"), "utf8"), LEDGER_LINE, String(configFile));
		}
	});

	it("loads with the owner's settings moved to context.json", () => {
		const dir = agentDir();
		oldFiles(dir);
		assert.ok(load(dir).registered.includes("command:context"));
		assert.equal(readFileSync(join(dir, "context.json"), "utf8"), OWNER_CONFIG);
		assert.equal(existsSync(join(dir, "sandy-context.json")), false);
	});

	it("tells the user once, at the first session start, what it moved", () => {
		const dir = agentDir();
		oldFiles(dir);
		const pi = load(dir);
		const notices: string[] = [];
		const ctx = { hasUI: true, ui: { notify: (text: string) => notices.push(text) } };
		// The bootstrap handler, registered first; the operational ones read a session this test has none of.
		const bootstrap = pi.handlers.find(({ event }) => event === "session_start");
		assert.ok(bootstrap);
		const start = () => bootstrap.handler({ reason: "startup" }, ctx);
		start();
		start();
		assert.equal(notices.length, 1);
		assert.match(notices[0] ?? "", /sandy-context\.json -> .*context\.json/);
	});

	it("stops the load, before anything is registered, when an old process recreated its config file", () => {
		const dir = agentDir();
		oldFiles(dir);
		load(dir);
		writeFileSync(join(dir, "sandy-context.json"), OWNER_CONFIG);
		process.env.PI_CODING_AGENT_DIR = dir;
		const pi = fakePi();
		assert.throws(() => createContextExtension({ ledgerFile: false, keepWarm: false })(pi.api), /sandy pi-lifecycle reload/);
		assert.deepEqual(pi.registered, []);
	});

	it("loads, and warns at the first session start, when an old process recreated its ledger directory", () => {
		const dir = agentDir();
		oldFiles(dir);
		load(dir);
		mkdirSync(join(dir, "sandy-context"));
		const pi = (() => {
			try {
				return load(dir);
			} catch (error) {
				assert.fail(`the load stopped: ${String(error)}`);
			}
		})();
		assert.ok(pi.registered.includes("command:context"));
		const notices: { text: string; level: string }[] = [];
		const ctx = { hasUI: true, ui: { notify: (text: string, level: string) => notices.push({ text, level }) } };
		const bootstrap = pi.handlers.find(({ event }) => event === "session_start");
		assert.ok(bootstrap);
		bootstrap.handler({ reason: "startup" }, ctx);
		assert.equal(notices.length, 1);
		assert.equal(notices[0]?.level, "warning");
		assert.match(notices[0]?.text ?? "", /sandy-context\b.*sandy pi-lifecycle reload/);
		assert.equal(existsSync(join(dir, "sandy-context")), true);
	});
});

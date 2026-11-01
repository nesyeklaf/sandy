import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import ship, { changedFiles, onChangedFiles, parseArgs } from "./ship.ts";

test("the stage and its ref come from the args; no args leaves the stage open", () => {
	assert.deepEqual(parseArgs("review origin/main"), { stage: "review", ref: "origin/main" });
	assert.deepEqual(parseArgs("Release"), { stage: "release", ref: undefined });
	assert.deepEqual(parseArgs(""), {});
	assert.throws(() => parseArgs("deploy"), /unknown stage deploy/);
});

test("findings on files outside the diff are dropped, a ./ prefix or :line suffix is tolerated", () => {
	const { kept, dropped } = onChangedFiles(
		[
			{ severity: "high", title: "a", file: "./src/a.ts" },
			{ severity: "low", title: "b", file: "src/b.ts:12" },
			{ severity: "medium", title: "c", file: "src/other.ts" },
			{ severity: "low", title: "d" },
		],
		["src/a.ts", "src/b.ts"],
	);
	assert.deepEqual(kept.map((f) => [f.title, f.file]), [["a", "src/a.ts"], ["b", "src/b.ts"], ["d", undefined]]);
	assert.deepEqual(dropped.map((f) => f.title), ["c"]);
});

test("changed files keep their real names, even ones git would quote", async () => {
	const repo = mkdtempSync(join(tmpdir(), "ship-"));
	const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base");
	for (const name of ["café.ts", 'say "hi".ts', "plain.ts"]) writeFileSync(join(repo, name), "x\n");
	git("add", ".");
	const session = {
		exec: async (command: string, args: string[]) => {
			const stdout = execFileSync(command, ["-C", repo, ...args], { encoding: "utf8" });
			return { code: 0, stdout, stderr: "" };
		},
	};
	assert.deepEqual((await changedFiles(session as never, ["--cached"])).sort(), ["café.ts", "plain.ts", 'say "hi".ts']);
});

type Call = [string, ...unknown[]];

/** A fake session whose git answers come from a table keyed by the git subcommand; step returns the given value/text. */
function fakeSession(git: Record<string, string>, step: { value?: unknown; text?: string }, calls: Call[]) {
	return {
		exec: async (_command: string, args: string[]) => {
			calls.push(["exec", args.join(" ")]);
			return { code: 0, stdout: git[args[0]] ?? "", stderr: "" };
		},
		step: async (input: unknown) => {
			calls.push(["step", input]);
			return { value: step.value, text: step.text ?? "" };
		},
		ask: async () => undefined,
	};
}

/** A fake LeaseTrack: advance answers from the queue, then { kind: "entered" }. */
function fakeLease(missingOutputs: string[], advances: unknown[], calls: Call[]) {
	return {
		station: { stage: "review", title: "Review", track: "t", missingOutputs },
		submit: async (input: unknown) => void calls.push(["submit", input]),
		advance: async (input: unknown) => {
			calls.push(["advance", input]);
			return advances.shift() ?? { kind: "entered" };
		},
		release: async (reason: string) => {
			calls.push(["release", reason]);
			return { released: true };
		},
	};
}

const reviewGit = { diff: "diff --git a/src/a.ts b/src/a.ts\n+x\n" };
const reviewValue = {
	findings: [
		{ severity: "high", title: "Leaks the handle", file: "src/a.ts", line: 7, detail: "close is never called" },
		{ severity: "low", title: "Elsewhere", file: "src/untouched.ts", line: 1 },
	],
};
// name-only lists the one touched file, any other diff call returns the diff text
const gitFor = (args: string[]) => (args.includes("--name-only") ? "src/a.ts\0" : reviewGit.diff);

function reviewSession(calls: Call[], value: unknown = reviewValue) {
	const session = fakeSession({}, { value }, calls);
	session.exec = async (_command: string, args: string[]) => {
		calls.push(["exec", args.join(" ")]);
		return { code: 0, stdout: gitFor(args), stderr: "" };
	};
	return session;
}

test("lease + review submits the kept findings as markdown and advances once", async () => {
	const calls: Call[] = [];
	const lease = fakeLease(["findings"], [], calls);
	const result: any = await ship("review origin/main", { session: reviewSession(calls) as never, lease: lease as never });
	const submit = calls.filter((call) => call[0] === "submit");
	assert.deepEqual(submit, [
		["submit", { outputs: { findings: "- [high] Leaks the handle (src/a.ts:7): close is never called\nDropped 1 finding(s) on files the diff does not touch." } }],
	]);
	assert.equal(calls.filter((call) => call[0] === "advance").length, 1);
	assert.equal(result.attempts.length, 1);
	assert.equal(result.findings.length, 1);
});

test("lease + review with no findings submits No findings.", async () => {
	const calls: Call[] = [];
	const lease = fakeLease(["findings"], [], calls);
	await ship("review origin/main", { session: reviewSession(calls, { findings: [] }) as never, lease: lease as never });
	assert.deepEqual(calls.find((call) => call[0] === "submit"), ["submit", { outputs: { findings: "No findings." } }]);
});

test("lease + release submits the notes", async () => {
	const calls: Call[] = [];
	const session = fakeSession({ describe: "v1\n", log: "abc1234 add thing\n" }, { value: { notes: " ## Added\n- thing \n" }, text: "ignored chatter" }, calls);
	const lease = fakeLease(["notes"], [], calls);
	const result: any = await ship("release v1", { session: session as never, lease: lease as never });
	assert.deepEqual(calls.find((call) => call[0] === "submit"), ["submit", { outputs: { notes: "## Added\n- thing" } }]);
	assert.equal(calls.filter((call) => call[0] === "advance").length, 1);
	assert.equal(result.notes, "## Added\n- thing");
});

// A step answered in text records whatever the model says last (live: "I can't tell whether the track has finished"),
// and a model that saw earlier steps calls autopilot_submit, which a step without a schema rejects.
test("the release step asks for the notes as a submitted value", async () => {
	const calls: Call[] = [];
	const session = fakeSession({ describe: "v1\n", log: "abc1234 add thing\n" }, { value: { notes: "x" } }, calls);
	await ship("release v1", { session: session as never });
	const step: any = calls.find((call) => call[0] === "step")?.[1];
	assert.deepEqual(step.schema?.required, ["notes"]);
	assert.equal(step.schema?.properties?.notes?.type, "string");
});

test("lease + release with no commits submits a no-commits note and runs no model step", async () => {
	const calls: Call[] = [];
	const session = fakeSession({ log: "" }, {}, calls);
	const lease = fakeLease(["notes"], [], calls);
	await ship("release v1", { session: session as never, lease: lease as never });
	assert.deepEqual(calls.find((call) => call[0] === "submit"), ["submit", { outputs: { notes: "No commits since v1." } }]);
	assert.equal(calls.filter((call) => call[0] === "step").length, 0);
});

test("advance is retried while the refusal says interrupted, at most twice; other refusals are final", async () => {
	const interrupted = { kind: "refused", reasons: ["gate check interrupted by restart"] };
	const calls: Call[] = [];
	const lease = fakeLease(["findings"], [interrupted, interrupted, interrupted, interrupted], calls);
	const result: any = await ship("review origin/main", { session: reviewSession(calls) as never, lease: lease as never });
	assert.equal(calls.filter((call) => call[0] === "advance").length, 3);
	assert.equal(result.attempts.length, 3);

	const retried: Call[] = [];
	const recovering = fakeLease(["findings"], [interrupted], retried);
	const done: any = await ship("review origin/main", { session: reviewSession(retried) as never, lease: recovering as never });
	assert.deepEqual(done.attempts, [{ refused: interrupted.reasons }, { kind: "entered" }]);

	const other: Call[] = [];
	const refusing = fakeLease(["findings"], [{ kind: "refused", reasons: ["tests missing"] }], other);
	const final: any = await ship("review origin/main", { session: reviewSession(other) as never, lease: refusing as never });
	assert.equal(other.filter((call) => call[0] === "advance").length, 1);
	assert.deepEqual(final.attempts, [{ refused: ["tests missing"] }]);
});

test("a stage that does not want the output ship writes releases the lease and submits nothing", async () => {
	for (const [args, wanted] of [["review origin/main", "findings"], ["release v1", "notes"]]) {
		const calls: Call[] = [];
		const lease = fakeLease(["something-else"], [], calls);
		await ship(args, { session: reviewSession(calls) as never, lease: lease as never });
		const release = calls.find((call) => call[0] === "release");
		assert.match(String(release?.[1]), new RegExp(`writes the output "${wanted}"`));
		assert.equal(calls.filter((call) => call[0] === "submit" || call[0] === "advance" || call[0] === "step").length, 0);
	}
});

test("without a lease ship returns the stage result as before", async () => {
	const calls: Call[] = [];
	const result = await ship("review origin/main", { session: reviewSession(calls) as never });
	assert.deepEqual(result, {
		stage: "review",
		base: "origin/main",
		files: ["src/a.ts"],
		findings: [reviewValue.findings[0]],
		dropped: [reviewValue.findings[1]],
	});
	const none = await ship("review origin/main", { session: reviewSession([]) as never, lease: null });
	assert.deepEqual((none as any).findings, [reviewValue.findings[0]]);
});

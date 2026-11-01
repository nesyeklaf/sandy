import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { resolveConfig } from "../src/core/config.ts";
import { CutFold, type CutInput, planCut } from "../src/core/cut.ts";
import { renderMasked } from "../src/core/serialize.ts";
import { estimateTokens } from "../src/core/tokens.ts";
import {
	MAX_PATH_CHARS,
	SKILLS_LISTED,
	SKILLS_SECTION_TOKENS,
	skillsLoaded,
	withoutSkillBodies,
} from "../src/core/skills.ts";
import type { LogEntry } from "../src/core/types.ts";
import { entry, session } from "./helpers.ts";
import { small } from "./support/core.ts";

const skillPath = (name: string): string => `/home/u/.agents/skills/${name}/SKILL.md`;

/** pi's expansion of `/skill:teach Explain monads.`: the whole SKILL.md body in the user message. */
const teachPrompt = `<skill name="teach" location="${skillPath("teach")}">\nReferences are relative to /home/u/.agents/skills/teach.\n\n${"Teach step by step. ".repeat(200)}\n</skill>\n\nExplain monads.`;

/** Skills loaded each way pi allows, then a dozen ordinary turns. */
function skillLog(): LogEntry[] {
	return [
		entry("s0", "user", teachPrompt),
		entry("s1", "assistant", "Loading the review skill.", {
			toolCalls: [{ id: "k1", name: "read", args: { path: skillPath("review") } }],
		}),
		entry("s2", "tool", "---\nname: review\n---\nReview rules", { toolName: "read" }),
		entry("s3", "assistant", "Loading two skills in codemode.", {
			toolCalls: [
				{
					id: "k2",
					name: "codemode",
					args: {
						code: `const s = await tools.read({ path: "${skillPath("audit")}" });\nconst t = await tools.bash({ command: "cat ~/.pi/agent/skills/vault-recall/SKILL.md" });\nreturn s;`,
					},
				},
			],
		}),
		entry("s4", "tool", "audit rules", { toolName: "codemode" }),
		entry("s5", "assistant", "Looking for skills and drafting one.", {
			toolCalls: [
				{ id: "k3", name: "find", args: { pattern: "**/SKILL.md" } },
				{ id: "k4", name: "write", args: { path: skillPath("draft"), content: "---\nname: draft\n---" } },
			],
		}),
		entry("s6", "tool", "found", { toolName: "find" }),
		...session(12),
	];
}

const input = (entries: LogEntry[]) => ({
	entries,
	minKeptIndex: 0,
	visibleFromIndex: 0,
	config: resolveConfig(small, { pinnedUserTokens: 1_000 }),
	reason: "watermark",
});

describe("skills in use", () => {
	it("recognizes a skill read directly, inside codemode or a shell, and by /skill:", () => {
		const log = skillLog();
		const loads = log.flatMap((e) => skillsLoaded(e));
		assert.deepEqual(loads, [
			{ name: "teach", path: skillPath("teach") },
			{ name: "review", path: skillPath("review") },
			{ name: "audit", path: skillPath("audit") },
			{ name: "vault-recall", path: "~/.pi/agent/skills/vault-recall/SKILL.md" },
		]);
	});

	it("lists every skill whose load was archived, newest first, with the entry to read it back", () => {
		const plan = planCut(input(skillLog()));
		assert.ok(plan);
		const section = /## Skills in use\n[^\n]+\n((?:- [^\n]+\n?)+)/.exec(plan.text);
		assert.ok(section, plan.text);
		assert.deepEqual(section[1]?.trimEnd().split("\n"), [
			`- audit: ${skillPath("audit")} (loaded #s3)`,
			"- vault-recall: ~/.pi/agent/skills/vault-recall/SKILL.md (loaded #s3)",
			`- review: ${skillPath("review")} (loaded #s1)`,
			`- teach: ${skillPath("teach")} (loaded #s0)`,
		]);
		assert.ok(plan.text.indexOf("## Skills in use") < plan.text.indexOf("## Earlier user messages"));
	});

	it("leaves out a skill whose newest load is still in the kept history", () => {
		const log = skillLog();
		log.push(
			entry("x1", "assistant", "Reading the review skill again.", {
				toolCalls: [{ id: "k9", name: "read", args: { path: skillPath("review") } }],
			}),
			entry("x2", "tool", "Review rules", { toolName: "read" }),
		);
		const plan = planCut(input(log));
		assert.ok(plan);
		assert.match(plan.text, /- audit: /);
		assert.doesNotMatch(plan.text, /- review: /);
	});

	it("adds no section when no skill was loaded", () => {
		const plan = planCut(input(session(12)));
		assert.ok(plan);
		assert.doesNotMatch(plan.text, /Skills in use/);
	});

	it("bounds the list and names how many it left out", () => {
		const log: LogEntry[] = [];
		for (let i = 0; i < SKILLS_LISTED + 5; i++) {
			log.push(
				entry(`k${i}`, "assistant", "", { toolCalls: [{ id: `k${i}`, name: "read", args: { path: skillPath(`s${i}`) } }] }),
				entry(`kt${i}`, "tool", "rules", { toolName: "read" }),
			);
		}
		const plan = planCut(input([...log, ...session(12)]));
		assert.ok(plan);
		assert.equal(plan.text.match(/^- s\d+: /gm)?.length, SKILLS_LISTED);
		assert.match(plan.text, new RegExp(`- s${SKILLS_LISTED + 4}: `));
		assert.match(plan.text, /\(5 older skills not shown; search for SKILL\.md\)/);
	});

	it("lists the same skills from pages read newest first as from the whole log", () => {
		const log = skillLog();
		const cuts: CutInput[] = [input(log), { ...input(log), keptFromId: "s3" }, { ...input(log), keptFromId: "u2" }];
		for (const cut of cuts) {
			const whole = planCut(cut);
			for (const size of [1, 3, 64]) {
				const fold = new CutFold({ ...cut, visibleFromId: cut.entries[cut.visibleFromIndex]?.id });
				const reversed = [...cut.entries].reverse();
				for (let at = 0; at < reversed.length; at += size) fold.add(reversed.slice(at, at + size));
				assert.deepEqual(fold.finish(), whole, `page size ${size}`);
			}
		}
		// Kept from s3: only what lies before it is archived.
		const fromS3 = planCut(cuts[1] as CutInput)?.text ?? "";
		assert.match(fromS3, /- review: [^\n]+\(loaded #s1\)\n- teach: /);
		assert.doesNotMatch(fromS3, /- audit: /);
	});

	it("pins a /skill: prompt as the request without the skill's body", () => {
		const plan = planCut(input(skillLog()));
		assert.ok(plan);
		const pinned = plan.text.split("\n").find((line) => line.startsWith("- [#s0 "));
		assert.ok(pinned, plan.text);
		assert.match(pinned, /<skill name="teach" location="[^"]+"\/> \(instructions under Skills in use\)/);
		assert.match(plan.text, /- \[#s0 [^\]]+\][\s\S]*Explain monads\./);
		assert.doesNotMatch(plan.text, /Teach step by step/);
		assert.doesNotMatch(renderMasked(entry("m", "user", teachPrompt)), /Teach step by step/);
		assert.equal(withoutSkillBodies("no skill here"), "no skill here");
	});

	it("reads a path as written: with spaces when quoted or whole, never a guess", () => {
		const read = (name: string, args: unknown) => skillsLoaded(entry("e", "assistant", "", { toolCalls: [{ id: "1", name, args }] }));
		assert.deepEqual(read("read", { path: "/home/u/My Skills/teach/SKILL.md" }), [
			{ name: "teach", path: "/home/u/My Skills/teach/SKILL.md" },
		]);
		assert.deepEqual(read("bash", { command: 'cat "/home/u/My Skills/teach/SKILL.md" | head' }), [
			{ name: "teach", path: "/home/u/My Skills/teach/SKILL.md" },
		]);
		assert.deepEqual(read("codemode", { code: "await tools.read({ path: `${ROOT}/skills/teach/SKILL.md` })" }), []);
		assert.deepEqual(read("bash", { command: "cat {{root}}/teach/SKILL.md $HOME/x/SKILL.md" }), []);
		assert.deepEqual(read("read", { path: `/${"x".repeat(MAX_PATH_CHARS)}/teach/SKILL.md` }), []);
		assert.deepEqual(read("bash", { command: `cat /${"x".repeat(MAX_PATH_CHARS)}/teach/SKILL.md` }), []);
		assert.deepEqual(read("read", { path: "/s/teach/SKILL.md.bak" }), []);
	});

	it("scans long arguments and malformed tags in linear time", () => {
		const big = "x".repeat(1_000_000);
		const started = performance.now();
		assert.deepEqual(
			skillsLoaded(entry("e", "assistant", "", { toolCalls: [{ id: "1", name: "codemode", args: { code: big } }] })),
			[],
		);
		const unclosed = '<skill name="x" location="/x/SKILL.md">'.repeat(25_000);
		assert.equal(withoutSkillBodies(unclosed), unclosed);
		assert.deepEqual(skillsLoaded(entry("u", "user", unclosed)), [{ name: "x", path: "/x/SKILL.md" }]);
		// Quadratic work on these inputs takes minutes; linear work takes milliseconds.
		assert.ok(performance.now() - started < 2_000, `took ${performance.now() - started} ms`);
	});

	it("skips an oversized tag and keeps the section within its token budget", () => {
		const huge = `<skill name="teach" location="/${"x".repeat(100_000)}/teach/SKILL.md">\nbody\n</skill>\n\nGo.`;
		const skipped = planCut(input([entry("h", "user", huge), ...session(12)]));
		assert.ok(skipped);
		assert.doesNotMatch(skipped.text, /Skills in use/);
		const log: LogEntry[] = [];
		for (let i = 0; i < SKILLS_LISTED; i++) {
			const path = `/${"d".repeat(MAX_PATH_CHARS - 20)}/s${i}/SKILL.md`;
			log.push(entry(`k${i}`, "assistant", "", { toolCalls: [{ id: `k${i}`, name: "read", args: { path } }] }));
		}
		const plan = planCut(input([...log, ...session(12)]));
		const section = /## Skills in use\n[\s\S]*?(?=\n\n##)/.exec(plan?.text ?? "")?.[0];
		assert.ok(section);
		assert.ok(estimateTokens(section) <= SKILLS_SECTION_TOKENS, `${estimateTokens(section)} tokens`);
		assert.match(section, /- s9: /);
		assert.match(section, /\(\d+ older skills not shown; search for SKILL\.md\)$/);
	});

	it("counts a skill once by name and skips paths with a variable", () => {
		const loop = entry("v", "assistant", "", {
			toolCalls: [
				{
					id: "v1",
					name: "codemode",
					args: {
						code: `for (const s of names) await tools.read({ path: \`~/.agents/skills/\${s}/SKILL.md\` });\nawait tools.bash({ command: "cat ~/.agents/skills/teach/SKILL.md /home/u/.agents/skills/teach/SKILL.md; ls $DIR/skills/x/SKILL.md" });`,
					},
				},
			],
		});
		assert.deepEqual(skillsLoaded(loop), [{ name: "teach", path: "~/.agents/skills/teach/SKILL.md" }]);
	});
});

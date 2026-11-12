import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { experimental_createBridgeJsonRpcTestHarness as createBridgeJsonRpcTestHarness } from "@sandy-sdk/plugin-sdk/provider-bridge/testing";
import type { ExperimentalSkillSelection as SkillSelection } from "@sandy-sdk/plugin-sdk/provider-bridge";
import { experimental_killAllChildrenForTests, handleLine } from "./bridge.js";
import {
  FULL_ACCESS_SESSION_OPTIONS,
  stubFakeCodexAppServer,
} from "./fake-codex-app-server-harness.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function launchArgsFor(
  selection: SkillSelection,
  options: { listError?: boolean } = {},
): Promise<{
  launches: string[][];
  paths: Record<"allowed" | "other" | "userOff", string>;
  startError: unknown;
}> {
  const cwd = mkdtempSync(join(tmpdir(), "sandy-codex-skill-selection-"));
  dirs.push(cwd);
  const launchLogPath = join(cwd, "launches.jsonl");
  const script = join(cwd, "script.json");
  const paths = {
    allowed: join(cwd, ".agents", "skills", "allowed", "SKILL.md"),
    other: join(cwd, ".agents", "skills", "other", "SKILL.md"),
    userOff: join(cwd, ".agents", "skills", "user-off", "SKILL.md"),
  };
  writeFileSync(
    script,
    JSON.stringify({
      launchLogPath,
      ...(options.listError ? { skillsListError: true } : {}),
      skillsList: {
        data: [
          {
            cwd,
            skills: [
              { name: "allowed", path: paths.allowed, enabled: true },
              { name: "other", path: paths.other, enabled: true },
              { name: "user-off", path: paths.userOff, enabled: false },
            ],
          },
        ],
      },
    }),
  );
  stubFakeCodexAppServer(script);
  const harness = createBridgeJsonRpcTestHarness(handleLine);
  const threadId = "thr_skill_selection_1";
  try {
    harness.sendRequest(1, "skills/configure", { roots: [], selection });
    expect((await harness.waitForResponse(1)).error).toBeUndefined();
    harness.sendRequest(2, "thread/start", {
      threadId,
      cwd,
      instructionMode: "append",
      options: FULL_ACCESS_SESSION_OPTIONS,
    });
    const startError = (await harness.waitForResponse(2)).error;
    if (!options.listError) expect(startError).toBeUndefined();
    const launches = readFileSync(launchLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) =>
        z.object({ args: z.array(z.string()) }).parse(JSON.parse(line)).args,
      );
    return { launches, paths, startError };
  } finally {
    harness.sendRequest(3, "thread/stop", {
      threadId,
      providerThreadId: "skill-selection-cleanup",
      intent: "release",
      activeTurnId: null,
    });
    await harness.waitForResponse(3).catch(() => undefined);
    harness.sendRequest(4, "skills/configure", {
      roots: [],
      selection: { mode: "inherit" },
    });
    await harness.waitForResponse(4).catch(() => undefined);
    experimental_killAllChildrenForTests();
    harness.restore();
    vi.unstubAllEnvs();
  }
}

function skillsConfigArg(args: readonly string[]): string | undefined {
  return args.find((arg) => arg.startsWith("skills.config="));
}

it("launches the session app-server without a skills override under inherit", async () => {
  const { launches } = await launchArgsFor({ mode: "inherit" });
  expect(launches).toHaveLength(1);
  expect(skillsConfigArg(launches[0] ?? [])).toBeUndefined();
});

it("disables the selected names and keeps the user's own disabled skills off", async () => {
  const { launches, paths } = await launchArgsFor({
    mode: "disable",
    names: ["other"],
  });
  expect(launches).toHaveLength(2);
  expect(skillsConfigArg(launches[0] ?? [])).toBeUndefined();
  expect(skillsConfigArg(launches[1] ?? [])).toBe(
    `skills.config=[{name="other",enabled=false},{path=${JSON.stringify(paths.userOff)},enabled=false}]`,
  );
});

it("disables every listed skill outside the allow-only names", async () => {
  const { launches, paths } = await launchArgsFor({
    mode: "allow-only",
    names: ["allowed"],
  });
  expect(launches).toHaveLength(2);
  expect(skillsConfigArg(launches[1] ?? [])).toBe(
    `skills.config=[{path=${JSON.stringify(paths.other)},enabled=false},{path=${JSON.stringify(paths.userOff)},enabled=false}]`,
  );
});

it.each([
  { mode: "disable", names: ["other"] },
  { mode: "allow-only", names: ["allowed"] },
] satisfies SkillSelection[])(
  "refuses to start a $mode session when Codex cannot list its skills",
  async (selection) => {
    const { launches, startError } = await launchArgsFor(selection, {
      listError: true,
    });
    expect(startError).toMatchObject({
      message: expect.stringContaining("could not list Codex skills"),
    });
    expect(launches).toHaveLength(1);
  },
);

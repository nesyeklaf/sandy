import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { experimental_nativeRootsResolveOutputSchema } from "@sandy-sdk/plugin-sdk/host";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolvePiNativeRoots } from "./native-roots.js";

let homeDir: string;

const itWithFakePi = it.skipIf(process.platform === "win32");

const NO_PI_ENV = { SANDY_PI_BRIDGE_COMMAND: "/nonexistent/sandy-test-pi" };

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), "sandy-pi-native-roots-"));
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(homeDir, { recursive: true, force: true });
});

function writeSettings(agentDir: string, settings: unknown): void {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
}

async function resolvedSkillPaths(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const answer = await resolvePiNativeRoots({
    homeDir,
    env: { ...NO_PI_ENV, ...env },
    cwd: null,
  });
  const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
  expect(parsed.commands).toEqual([]);
  for (const root of parsed.skills) {
    expect(root).toMatchObject({
      origin: "user",
      recursive: true,
      shape: "skills",
      namePrefix: "",
    });
  }
  return parsed.skills.map((root) => root.path);
}

it("answers empty without a settings file or with an unreadable one", async () => {
  await expect(resolvedSkillPaths({})).resolves.toEqual([]);
  mkdirSync(join(homeDir, ".pi", "agent"), { recursive: true });
  writeFileSync(join(homeDir, ".pi", "agent", "settings.json"), "{not json");
  await expect(resolvedSkillPaths({})).resolves.toEqual([]);
});

it("resolves plain skill entries against home, the agent dir, or as given, and drops the rest", async () => {
  writeSettings(join(homeDir, ".pi", "agent"), {
    skills: [
      "/opt/team-skills",
      "~/shared/skills",
      "local-skills/",
      "team/one-skill/SKILL.md",
      "notes/single-skill.md",
      "!disabled-pattern",
      "npm:@acme/pi-skills",
      "git:github.com/acme/skills",
      "https://example.invalid/skills",
      "  ",
      "/opt/team-skills",
    ],
  });
  await expect(resolvedSkillPaths({})).resolves.toEqual(
    [
      resolve("/opt/team-skills"),
      join(homeDir, ".pi", "agent", "local-skills"),
      join(homeDir, "shared", "skills"),
    ].sort(),
  );
});

it("adds the moved agent dir's skills directory when PI_CODING_AGENT_DIR points elsewhere", async () => {
  const agentDir = join(homeDir, "custom-agent");
  writeSettings(agentDir, { skills: [] });
  await expect(
    resolvedSkillPaths({ PI_CODING_AGENT_DIR: agentDir }),
  ).resolves.toEqual([join(agentDir, "skills")]);
  await expect(
    resolvedSkillPaths({ PI_CODING_AGENT_DIR: "~/custom-agent" }),
  ).resolves.toEqual([join(agentDir, "skills")]);
});

it("never answers a root the contract would refuse", async () => {
  writeSettings(join(homeDir, ".pi", "agent"), {
    skills: [
      "/opt/../etc/skills",
      "/opt//skills",
      "relative/../escape",
      "/srv/skills/",
      "~/team-skills//",
    ],
  });
  await expect(resolvedSkillPaths({})).resolves.toEqual(
    [
      resolve("/etc/skills"),
      resolve("/opt/skills"),
      join(homeDir, ".pi", "agent", "escape"),
      resolve("/srv/skills"),
      join(homeDir, "team-skills"),
    ].sort(),
  );
});

const FAKE_PI_INDEX = `
import { writeFileSync } from "node:fs";
export const SettingsManager = {
  create(cwd, agentDir, options) {
    if (process.env.FAKE_PI_RECORD) {
      writeFileSync(process.env.FAKE_PI_RECORD, JSON.stringify({ cwd, agentDir, options }));
    }
    return {};
  },
};
export class DefaultPackageManager {
  async resolve() {
    if (process.env.FAKE_PI_MODE === "crash") throw new Error("boom");
    if (process.env.FAKE_PI_MODE === "invalid") return { skills: [{ path: 7 }] };
    if (process.env.FAKE_PI_MODE === "garbage") {
      process.stdout.write("not json");
      return { skills: [] };
    }
    return {
      skills: JSON.parse(process.env.FAKE_PI_SKILLS).map((skill) => ({
        path: skill.path,
        enabled: skill.enabled ?? true,
        metadata: {
          scope: skill.scope ?? "user",
          origin: skill.origin ?? "package",
          source: skill.source ?? "git:github.com/acme/skills",
        },
      })),
    };
  }
}
`;

function installFakePi(launcher: "symlink" | "wrapper" = "symlink"): {
  binDir: string;
  skillsDir: string;
  record: string;
} {
  const packageDir = join(
    homeDir,
    "lib",
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
  );
  mkdirSync(join(packageDir, "dist"), { recursive: true });
  writeFileSync(
    join(packageDir, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      bin: { pi: "dist/cli.js" },
    }),
  );
  writeFileSync(join(packageDir, "dist", "index.js"), FAKE_PI_INDEX);
  const cli = join(packageDir, "dist", "cli.js");
  writeFileSync(cli, "#!/usr/bin/env node\n");
  chmodSync(cli, 0o755);
  const binDir = join(homeDir, "bin");
  mkdirSync(binDir, { recursive: true });
  if (launcher === "symlink") {
    symlinkSync(cli, join(binDir, "pi"));
  } else {
    const wrapper = join(binDir, "pi");
    writeFileSync(wrapper, `#!/bin/sh\nexec /usr/bin/node ${cli} "$@"\n`);
    chmodSync(wrapper, 0o755);
  }
  return {
    binDir,
    skillsDir: join(homeDir, "pkg-skills"),
    record: join(homeDir, "record.json"),
  };
}

function fakePiEnv(
  fake: { binDir: string; record: string },
  skills: unknown,
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  return {
    PATH: fake.binDir,
    FAKE_PI_RECORD: fake.record,
    FAKE_PI_SKILLS: JSON.stringify(skills),
    ...extra,
  };
}

itWithFakePi(
  "answers the package skills Pi itself resolved, one skill root each, and drops disabled and top-level entries",
  async () => {
    const fake = installFakePi();
    const env = fakePiEnv(fake, [
      { path: join(fake.skillsDir, "b-skill", "SKILL.md") },
      { path: join(fake.skillsDir, "a-skill", "SKILL.md") },
      { path: join(fake.skillsDir, "a-skill", "SKILL.md") },
      { path: join(fake.skillsDir, "off", "SKILL.md"), enabled: false },
      {
        path: join(homeDir, ".agents", "skills", "auto", "SKILL.md"),
        source: "auto",
        origin: "top-level",
      },
      {
        path: join(homeDir, ".pi", "agent", "skills", "listed", "SKILL.md"),
        source: "local",
        origin: "top-level",
      },
      { path: join(fake.skillsDir, "notes.md") },
      {
        path: join(homeDir, "work", ".pi", "skills", "proj", "SKILL.md"),
        scope: "project",
        source: "local",
      },
    ]);
    mkdirSync(join(homeDir, "work"), { recursive: true });
    const answer = await resolvePiNativeRoots({
      homeDir,
      env,
      cwd: join(homeDir, "work"),
    });
    const parsed = experimental_nativeRootsResolveOutputSchema.parse(answer);
    expect(
      parsed.skills.map(({ path, origin, shape, recursive }) => ({
        path,
        origin,
        shape,
        recursive,
      })),
    ).toEqual(
      [
        {
          path: join(fake.skillsDir, "a-skill"),
          origin: "user",
          shape: "skill",
          recursive: false,
        },
        {
          path: join(fake.skillsDir, "b-skill"),
          origin: "user",
          shape: "skill",
          recursive: false,
        },
        {
          path: join(homeDir, "work", ".pi", "skills", "proj"),
          origin: "project",
          shape: "skill",
          recursive: false,
        },
      ].sort((x, y) => (x.path < y.path ? -1 : 1)),
    );
    expect(JSON.parse(readFileSync(fake.record, "utf8"))).toEqual({
      cwd: join(homeDir, "work"),
      agentDir: join(homeDir, ".pi", "agent"),
      options: { projectTrusted: true },
    });
  },
);

itWithFakePi(
  "adds Pi's package skills to the settings.json skill roots",
  async () => {
    const fake = installFakePi();
    writeSettings(join(homeDir, ".pi", "agent"), {
      skills: ["/opt/team-skills", "npm:@acme/skills"],
    });
    const env = fakePiEnv(fake, [
      { path: join(fake.skillsDir, "a-skill", "SKILL.md") },
    ]);
    const answer = await resolvePiNativeRoots({ homeDir, env, cwd: null });
    expect(
      experimental_nativeRootsResolveOutputSchema
        .parse(answer)
        .skills.map(({ path, shape }) => ({ path, shape })),
    ).toEqual([
      { path: resolve("/opt/team-skills"), shape: "skills" },
      { path: join(fake.skillsDir, "a-skill"), shape: "skill" },
    ]);
    expect(console.warn).not.toHaveBeenCalled();
  },
);

itWithFakePi(
  "hands Pi the agent dir and home sandy resolved, not the daemon's own",
  async () => {
    const fake = installFakePi();
    const agentDir = join(homeDir, "moved-agent");
    const env = fakePiEnv(fake, [], {
      PI_CODING_AGENT_DIR: agentDir,
      HOME: "/nonexistent/daemon-home",
    });
    await resolvePiNativeRoots({ homeDir, env, cwd: null });
    expect(JSON.parse(readFileSync(fake.record, "utf8"))).toEqual({
      cwd: agentDir,
      agentDir,
      options: { projectTrusted: false },
    });
  },
);

itWithFakePi("finds the Pi package behind a shell wrapper script", async () => {
  const fake = installFakePi("wrapper");
  const env = fakePiEnv(fake, [
    { path: join(fake.skillsDir, "a-skill", "SKILL.md") },
  ]);
  const answer = await resolvePiNativeRoots({ homeDir, env, cwd: null });
  expect(
    experimental_nativeRootsResolveOutputSchema
      .parse(answer)
      .skills.map((root) => root.path),
  ).toEqual([join(fake.skillsDir, "a-skill")]);
});

itWithFakePi(
  "resolves without a workspace as an untrusted run in the agent dir",
  async () => {
    const fake = installFakePi();
    const env = fakePiEnv(fake, []);
    const answer = await resolvePiNativeRoots({ homeDir, env, cwd: null });
    expect(
      experimental_nativeRootsResolveOutputSchema.parse(answer).skills,
    ).toEqual([]);
    expect(JSON.parse(readFileSync(fake.record, "utf8"))).toEqual({
      cwd: join(homeDir, ".pi", "agent"),
      agentDir: join(homeDir, ".pi", "agent"),
      options: { projectTrusted: false },
    });
  },
);

it("falls back to settings.json skills when Pi cannot be found", async () => {
  writeSettings(join(homeDir, ".pi", "agent"), {
    skills: ["/opt/team-skills"],
  });
  const answer = await resolvePiNativeRoots({
    homeDir,
    env: NO_PI_ENV,
    cwd: null,
  });
  expect(
    experimental_nativeRootsResolveOutputSchema
      .parse(answer)
      .skills.map((root) => root.path),
  ).toEqual([resolve("/opt/team-skills")]);
  expect(console.warn).toHaveBeenCalledWith(
    expect.stringContaining("falling back to settings.json skills"),
  );
});

itWithFakePi.each(["crash", "invalid", "garbage"])(
  "falls back to settings.json skills when Pi's resolver child fails (%s)",
  async (mode) => {
    const fake = installFakePi();
    writeSettings(join(homeDir, ".pi", "agent"), {
      skills: ["/opt/team-skills"],
    });
    const env = fakePiEnv(fake, [], { FAKE_PI_MODE: mode });
    const answer = await resolvePiNativeRoots({ homeDir, env, cwd: null });
    expect(
      experimental_nativeRootsResolveOutputSchema
        .parse(answer)
        .skills.map((root) => root.path),
    ).toEqual([resolve("/opt/team-skills")]);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("falling back to settings.json skills"),
    );
  },
);

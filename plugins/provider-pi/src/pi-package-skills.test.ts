import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePiPackageSkillRoots } from "./pi-package-skills.js";

const STUB_INDEX = `
export const SettingsManager = { create: () => ({}) };
export class DefaultPackageManager {
  async resolve() {
    return { skills: [{ path: "/managed/skill/SKILL.md", enabled: true,
      metadata: { scope: "user", origin: "package", source: "managed-fixture" } }] };
  }
}
`;

describe("resolvePiPackageSkillRoots", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  it("finds the Pi package behind the managed-install launcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "sandy-pi-managed-install-"));
    dirs.push(root);
    const agentDir = join(root, ".pi", "agent");
    const launcher = join(agentDir, "bin", "pi");
    mkdirSync(join(agentDir, "bin"), { recursive: true });
    writeFileSync(launcher, '#!/bin/sh\nexec "$pi_release_bin" "$@"\n');
    chmodSync(launcher, 0o755);
    mkdirSync(join(agentDir, "install"), { recursive: true });
    writeFileSync(join(agentDir, "install", "current-version"), "9.9.9\n");
    const packageDir = join(
      agentDir,
      "install",
      "releases",
      "9.9.9",
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
    );
    mkdirSync(join(packageDir, "dist"), { recursive: true });
    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        type: "module",
      }),
    );
    writeFileSync(join(packageDir, "dist", "index.js"), STUB_INDEX);
    const work = join(root, "work");
    mkdirSync(work, { recursive: true });
    const skills = await resolvePiPackageSkillRoots({
      cwd: work,
      homeDir: root,
      agentDir,
      env: { ...process.env, SANDY_PI_BRIDGE_COMMAND: launcher },
    });
    expect(skills).toEqual([{ path: "/managed/skill", origin: "user" }]);
  });
});

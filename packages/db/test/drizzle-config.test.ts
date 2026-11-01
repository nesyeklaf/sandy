import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDevInstanceConfig } from "@sandy/config/runtime";
import { resolveDrizzleDataDir } from "../drizzle.config.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..", "..", "..");

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("drizzle config", () => {
  it("uses the current checkout data dir in development", () => {
    vi.stubEnv("SANDY_DATA_DIR", "~/custom-sandy");

    expect(resolveDrizzleDataDir("dev")).toBe(
      resolveDevInstanceConfig({
        homeDir: os.homedir(),
        repoRoot,
      }).dataDir,
    );
  });

  it("respects SANDY_DATA_DIR in production", () => {
    vi.stubEnv("SANDY_DATA_DIR", "~/custom-sandy");

    expect(resolveDrizzleDataDir("prod")).toBe(join(os.homedir(), "custom-sandy"));
  });
});

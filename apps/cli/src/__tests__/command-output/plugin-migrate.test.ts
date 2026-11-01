import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PLUGIN_SDK_VERSION } from "@sandy/domain";
import {
  collectLogPayloads,
  readlineMocks,
  runCommand,
  setupCommandOutputTestEnvironment,
} from "../helpers/command-output-harness.js";
import { registerPluginCommands } from "../../commands/plugin.js";

const register = (program: Parameters<typeof registerPluginCommands>[0]) => {
  registerPluginCommands(program, () => "http://server");
};

setupCommandOutputTestEnvironment();

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "sandy-cli-migrate-"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

async function writeManifest(value: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(rootDir, "package.json"),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function writeVendoredPlugin(): Promise<void> {
  await writeManifest({
    name: "sandy-plugin-legacy",
    version: "0.1.0",
    engines: { sandyPluginSdk: ">=0.2.0" },
    sandy: {
      name: "Legacy plugin",
      description: "Legacy SDK layout fixture.",
      branding: { icon: "Zap" },
      server: "./server.ts",
    },
    devDependencies: { typescript: "^5.7.0" },
  });
  await writeFile(
    join(rootDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          paths: { "@sandy-sdk/plugin-sdk": ["./types/sandy-plugin-sdk.d.ts"] },
        },
        include: ["server.ts", "types"],
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(rootDir, "types"), { recursive: true });
  await writeFile(join(rootDir, "types", "sandy-plugin-sdk.d.ts"), "// old\n");
}

async function readManifest(): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    await readFile(join(rootDir, "package.json"), "utf8"),
  );
  return parsed as Record<string, unknown>;
}

function setTty(value: boolean): void {
  Object.defineProperty(process.stdin, "isTTY", {
    value,
    configurable: true,
  });
}

describe("sandy plugin migrate", () => {
  it("prints the plan and changes nothing without --yes on a non-TTY", async () => {
    await writeVendoredPlugin();
    setTty(false);
    const before = await readFile(join(rootDir, "package.json"), "utf8");
    const logSpy = vi.mocked(console.log);

    await expect(
      runCommand(["plugin", "migrate", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    const logged = collectLogPayloads(logSpy).join("\n");
    expect(logged).toContain(
      `"@sandy-sdk/plugin-sdk": (none) → ${PLUGIN_SDK_VERSION}`,
    );
    expect(logged).toContain("delete         types/sandy-plugin-sdk.d.ts");
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "Refusing to migrate without confirmation",
    );
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(
      await stat(join(rootDir, "types", "sandy-plugin-sdk.d.ts")).then(() => true),
    ).toBe(true);
  });

  it("migrates with --yes and reports the follow-up install", async () => {
    await writeVendoredPlugin();
    setTty(false);

    await runCommand(["plugin", "migrate", rootDir, "--yes"], register);

    const manifest = await readManifest();
    expect(
      (manifest.devDependencies as Record<string, string>)[
        "@sandy-sdk/plugin-sdk"
      ],
    ).toBe(PLUGIN_SDK_VERSION);
    await expect(
      stat(join(rootDir, "types", "sandy-plugin-sdk.d.ts")),
    ).rejects.toThrow();
    const logged = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(logged).toContain("Migrated to the @sandy-sdk/plugin-sdk npm package.");
    expect(logged).toContain("Run `npm install`");
  });

  it("plans and applies the pre-rename import rewrite", async () => {
    await writeVendoredPlugin();
    await writeFile(
      join(rootDir, "server.ts"),
      'import type { SandyPluginApi } from "@sandy/plugin-sdk";\nimport "@sandy/plugin-sdk/testing";\n',
    );
    setTty(false);

    await runCommand(["plugin", "migrate", rootDir, "--yes"], register);

    const logged = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(logged).toContain(
      'rewrite        server.ts (2 imports of "@sandy/plugin-sdk" → "@sandy-sdk/plugin-sdk")',
    );
    expect(await readFile(join(rootDir, "server.ts"), "utf8")).toBe(
      'import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";\nimport "@sandy-sdk/plugin-sdk/testing";\n',
    );
  });

  it("reports an already-migrated plugin without touching it", async () => {
    await writeManifest({
      name: "sandy-plugin-modern",
      engines: { sandyPluginSdk: `>=${PLUGIN_SDK_VERSION}` },
      sandy: { server: "./server.ts" },
      devDependencies: { "@sandy-sdk/plugin-sdk": PLUGIN_SDK_VERSION },
    });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await runCommand(["plugin", "migrate", rootDir], register);

    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      "Already migrated",
    );
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
  });

  it("pins a package-layout plugin that never got the devDependency", async () => {
    await writeManifest({
      name: "sandy-plugin-pinless",
      sandy: { server: "./server.ts" },
      devDependencies: { typescript: "^5.7.0" },
    });
    setTty(false);

    await runCommand(["plugin", "migrate", rootDir, "--yes"], register);

    const manifest = await readManifest();
    expect(
      (manifest.devDependencies as Record<string, string>)[
        "@sandy-sdk/plugin-sdk"
      ],
    ).toBe(PLUGIN_SDK_VERSION);
    expect((manifest.engines as Record<string, string>).sandyPluginSdk).toBe(
      `>=${PLUGIN_SDK_VERSION}`,
    );
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).not.toContain(
      "Already migrated",
    );
  });

  it("aborts when the plugin changes between the plan and the confirmation", async () => {
    await writeVendoredPlugin();
    setTty(true);
    readlineMocks.question.mockImplementation(async () => {
      await writeFile(
        join(rootDir, "types", "sandy-plugin-sdk-app.d.ts"),
        "// appeared mid-prompt\n",
      );
      return "y";
    });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await expect(
      runCommand(["plugin", "migrate", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "changed while awaiting confirmation",
    );
    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(
      await stat(join(rootDir, "types", "sandy-plugin-sdk.d.ts")).then(() => true),
    ).toBe(true);
  });
});

describe("sandy plugin dev stale-pin warning", () => {
  function stubEmptyPluginList(): void {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ plugins: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );
  }

  it("warns when an exact pin differs from this sandy's SDK version", async () => {
    await writeManifest({
      name: "sandy-plugin-modern",
      sandy: { server: "./server.ts" },
      devDependencies: { "@sandy-sdk/plugin-sdk": "0.2.0" },
    });
    stubEmptyPluginList();

    await expect(
      runCommand(["plugin", "dev", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).toContain(
      `This plugin pins @sandy-sdk/plugin-sdk 0.2.0; this sandy's SDK is ${PLUGIN_SDK_VERSION}`,
    );
  });

  it("stays quiet for a matching pin and for a range", async () => {
    await writeManifest({
      name: "sandy-plugin-modern",
      sandy: { server: "./server.ts" },
      devDependencies: { "@sandy-sdk/plugin-sdk": PLUGIN_SDK_VERSION },
    });
    stubEmptyPluginList();
    await expect(
      runCommand(["plugin", "dev", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    await writeManifest({
      name: "sandy-plugin-modern",
      sandy: { server: "./server.ts" },
      devDependencies: { "@sandy-sdk/plugin-sdk": "^0.2.0" },
    });
    stubEmptyPluginList();
    await expect(
      runCommand(["plugin", "dev", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.warn).mock.calls.flat().join("\n")).not.toContain(
      "This plugin pins @sandy-sdk/plugin-sdk",
    );
  });
});

describe("legacy vendored SDK layout", () => {
  const message =
    "This plugin uses the legacy vendored SDK layout. Its SDK types will not be updated.\n" +
    "Please run `sandy plugin migrate` to update to the latest SDK types.";

  it.each([false, true])(
    "requires migration for sandy plugin types with check=%s",
    async (check) => {
      await writeVendoredPlugin();
      const declarationsPath = join(rootDir, "types", "sandy-plugin-sdk.d.ts");
      const before = await readFile(declarationsPath, "utf8");

      await expect(
        runCommand(
          ["plugin", "types", rootDir, ...(check ? ["--check"] : [])],
          register,
        ),
      ).rejects.toThrow("process.exit:1");

      expect(vi.mocked(console.error)).toHaveBeenCalledWith(message);
      expect(await readFile(declarationsPath, "utf8")).toBe(before);
    },
  );

  it("warns and continues sandy plugin dev", async () => {
    await writeVendoredPlugin();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ plugins: [] }), {
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      runCommand(["plugin", "dev", rootDir], register),
    ).rejects.toThrow("process.exit:1");

    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(message);
    expect(vi.mocked(console.error).mock.calls.flat().join("\n")).toContain(
      "This directory is not installed as a plugin",
    );
  });

  it("warns and continues sandy plugin build", async () => {
    await writeVendoredPlugin();
    await writeFile(join(rootDir, "server.ts"), "export default () => {};\n");

    await runCommand(["plugin", "build", rootDir], register);

    expect(vi.mocked(console.warn)).toHaveBeenCalledWith(message);
    await expect(
      stat(join(rootDir, "dist", "server.js")),
    ).resolves.toBeDefined();
  });
});

describe("sandy plugin types on a package-layout plugin", () => {
  it("repoints an outdated pin to the running host's SDK version", async () => {
    await writeManifest({
      name: "sandy-plugin-modern",
      engines: { sandyPluginSdk: ">=0.2.0" },
      sandy: { server: "./server.ts" },
      devDependencies: { "@sandy-sdk/plugin-sdk": "0.2.0" },
    });

    await runCommand(["plugin", "types", rootDir], register);

    const manifest = await readManifest();
    expect(
      (manifest.devDependencies as Record<string, string>)[
        "@sandy-sdk/plugin-sdk"
      ],
    ).toBe(PLUGIN_SDK_VERSION);
    expect((manifest.engines as Record<string, string>).sandyPluginSdk).toBe(
      ">=0.2.0",
    );
    const logged = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(logged).toContain(`0.2.0 → ${PLUGIN_SDK_VERSION}`);
    expect(logged).toContain("Run `npm install`");
  });

  it("--check reports the mismatch and writes nothing", async () => {
    await writeManifest({
      name: "sandy-plugin-modern",
      sandy: { server: "./server.ts" },
      devDependencies: { "@sandy-sdk/plugin-sdk": "0.2.0" },
    });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await expect(
      runCommand(["plugin", "types", rootDir, "--check"], register),
    ).rejects.toThrow("process.exit:1");

    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
  });

  it("is a no-op when the pin already matches", async () => {
    await writeManifest({
      name: "sandy-plugin-modern",
      sandy: { server: "./server.ts" },
      devDependencies: { "@sandy-sdk/plugin-sdk": PLUGIN_SDK_VERSION },
    });
    const before = await readFile(join(rootDir, "package.json"), "utf8");

    await runCommand(["plugin", "types", rootDir], register);

    expect(await readFile(join(rootDir, "package.json"), "utf8")).toBe(before);
    expect(collectLogPayloads(vi.mocked(console.log)).join("\n")).toContain(
      `already pinned to ${PLUGIN_SDK_VERSION}`,
    );
  });
});

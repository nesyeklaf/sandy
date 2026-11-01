import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import { createTestAppHarness } from "../../helpers/test-app.js";

async function rpcValidationWarning(
  schema: z.ZodType,
  input: unknown,
): Promise<string | undefined> {
  const harness = await createTestAppHarness();
  const rootDir = await mkdtemp(join(tmpdir(), "sandy-rpc-diagnostics-"));
  const warn = vi.spyOn(harness.deps.logger, "warn");
  try {
    await writeFile(
      join(rootDir, "package.json"),
      JSON.stringify({
        name: "sandy-plugin-rpc-diagnostics",
        version: "0.1.0",
        sandy: {
          name: "RPC diagnostics fixture",
          description: "Validation logging fixture",
          branding: { icon: "Zap" },
          server: "./server.ts",
        },
      }),
    );
    await writeFile(
      join(rootDir, "server.ts"),
      "export default function plugin() {}",
    );
    expect((await harness.pluginService.installPath(rootDir)).status).toBe(
      "running",
    );
    const api = harness.pluginService.getApi("rpc-diagnostics");
    if (!api) throw new Error("fixture plugin did not start");
    api.rpc.register(
      defineRpcContract({ inspect: { input: schema, output: z.null() } }),
      {
        inspect: () => null,
      },
    );
    const response = await harness.app.request(
      "/api/v1/plugins/rpc-diagnostics/rpc/inspect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    expect(response.status).toBe(400);
    const call = warn.mock.calls.find((args) =>
      String(args.at(-1)).includes("rpc inspect failed:"),
    );
    expect(call?.[0]).toEqual({ pluginId: "rpc-diagnostics" });
    return call === undefined ? undefined : String(call.at(-1));
  } finally {
    warn.mockRestore();
    await harness.pluginService.stop();
    await harness.cleanup();
    await rm(rootDir, { recursive: true, force: true });
  }
}

it("names each failing field and unrecognized key in the warning", async () => {
  const warning = await rpcValidationWarning(
    z
      .object({
        id: z.string(),
        entries: z.array(z.object({ count: z.number() })),
      })
      .strict(),
    { entries: [{ count: "private-payload" }], extra: "private-payload" },
  );
  expect(warning).toBe(
    "[plugin:rpc-diagnostics] rpc inspect failed: rpc input validation failed (" +
      "id: Invalid input: expected string, received undefined; " +
      "entries.0.count: Invalid input: expected number, received string; " +
      'Unrecognized key: "extra")',
  );
});

it("caps the issue summary at 300 characters", async () => {
  const key = "field".repeat(30);
  const warning = await rpcValidationWarning(
    z.object(
      Object.fromEntries(
        ["a", "b", "c", "d"].map((suffix) => [`${key}${suffix}`, z.string()]),
      ),
    ),
    {},
  );
  const prefix =
    "[plugin:rpc-diagnostics] rpc inspect failed: rpc input validation failed (";
  expect(warning?.startsWith(prefix)).toBe(true);
  const summary = warning?.slice(prefix.length, -1);
  expect(summary).toHaveLength(300);
  expect(summary?.endsWith("…")).toBe(true);
});

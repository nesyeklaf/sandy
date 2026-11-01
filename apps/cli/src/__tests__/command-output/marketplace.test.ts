import { isAbsolute, resolve, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  collectLogPayloads,
  runCommand,
  setupCommandOutputTestEnvironment,
  type CommandRegistrar,
} from "../helpers/command-output-harness.js";
import { registerMarketplaceCommands } from "../../commands/marketplace.js";

const acme = {
  name: "acme-plugins",
  displayName: "Acme Plugins",
  description: "Plugins the Acme team maintains.",
  official: false,
  sourceKind: "path" as const,
  source: "path:/work/acme-marketplace",
  resolvedCommit: null,
  entryCount: 2,
  lastRefreshAt: 1_700_000_000_000,
  lastAttemptAt: 1_700_000_000_000,
  lastError: null,
};

const bundled = {
  ...acme,
  name: "sandy-official",
  displayName: "SANDY Official",
  official: true,
  source: "/app/builtin-plugins",
  entryCount: 25,
};

function json(value: object, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("sandy marketplace", () => {
  setupCommandOutputTestEnvironment();
  const register: CommandRegistrar = (program) =>
    registerMarketplaceCommands(program, () => "http://server");

  it("adds a marketplace and says that nothing was installed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: true, marketplace: acme }),
    );

    await runCommand(
      ["marketplace", "add", "path:/work/acme-marketplace"],
      register,
    );

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "http://server/api/v1/marketplaces",
    );
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)),
    ).toEqual({ source: `path:${resolve("/work/acme-marketplace")}` });
    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Added marketplace acme-plugins");
    expect(output).toContain("Adding a marketplace installs nothing");
    expect(output).toContain("sandy plugin install <id>@acme-plugins");
  });

  it("sends --subdirectory with a git source and prints the stored subdirectory", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({
        ok: true,
        marketplace: {
          ...acme,
          sourceKind: "git",
          source: "git:https://github.com/acme/agent-plugins.git@main",
          subdirectory: "sandy",
          resolvedCommit: "0123456789abcdef0123456789abcdef01234567",
        },
      }),
    );

    await runCommand(
      [
        "marketplace",
        "add",
        "git:https://github.com/acme/agent-plugins.git@main",
        "--subdirectory",
        "sandy",
      ],
      register,
    );

    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)),
    ).toEqual({
      source: "git:https://github.com/acme/agent-plugins.git@main",
      subdirectory: "sandy",
    });
    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain(
      "source: git:https://github.com/acme/agent-plugins.git@main",
    );
    expect(output).toContain("subdirectory: sandy");
  });

  it("resolves a relative path: source on the invoking machine", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: true, marketplace: { ...acme, sourceKind: "path" } }),
    );

    await runCommand(["marketplace", "add", "path:./catalog"], register);

    const body = JSON.parse(
      String(vi.mocked(fetch).mock.calls[0]?.[1]?.body),
    ) as { source: string };
    expect(body.source.startsWith("path:")).toBe(true);
    expect(isAbsolute(body.source.slice("path:".length))).toBe(true);
    expect(body.source.endsWith(`${sep}catalog`)).toBe(true);
  });

  it("lists marketplaces with their source and entry count", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ marketplaces: [bundled, acme] }),
    );

    await runCommand(["marketplace", "list"], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("sandy-official");
    expect(output).toContain("acme-plugins");
    expect(output).toContain("path:/work/acme-marketplace");
    expect(output).not.toContain("Subdirectory");
  });

  it("lists the subdirectory a git marketplace is read from", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({
        marketplaces: [
          {
            ...acme,
            sourceKind: "git",
            source: "git:https://acme.test/repo.git@main",
            subdirectory: "sandy",
          },
        ],
      }),
    );

    await runCommand(["marketplace", "list"], register);

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toMatch(/Source\s+Subdirectory\s+Entries/u);
    expect(output).toMatch(
      /git:https:\/\/acme\.test\/repo\.git@main\s+sandy\s+2\s/u,
    );
  });

  it("reports a failed refresh and exits non-zero without hiding the rest", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({
        results: [
          {
            name: "sandy-official",
            ok: true,
            error: null,
            marketplace: bundled,
          },
          {
            name: "acme-plugins",
            ok: false,
            error: "request failed with HTTP 503",
            marketplace: acme,
          },
        ],
      }),
    );

    await expect(
      runCommand(["marketplace", "refresh"], register),
    ).rejects.toThrow("process.exit:1");

    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("sandy-official: 25 entries");
    expect(output).toContain("acme-plugins: refresh failed");
    expect(output).toContain("keeping the last catalog");
  });

  it("names the plugins a removal kept as direct installs", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      json({ ok: true, convertedPluginIds: ["notes", "status"] }),
    );

    await runCommand(["marketplace", "remove", "acme-plugins"], register);

    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "http://server/api/v1/marketplaces/acme-plugins",
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.method).toBe("DELETE");
    const output = collectLogPayloads(vi.mocked(console.log)).join("\n");
    expect(output).toContain("Removed marketplace acme-plugins.");
    expect(output).toContain("Kept as direct installs: notes, status");
  });
});

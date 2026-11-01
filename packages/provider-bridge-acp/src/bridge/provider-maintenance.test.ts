import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURSOR_ACP_MAINTENANCE,
  __testing,
  getAcpProviderHealth,
  getAcpProviderInstallationStatus,
} from "./provider-maintenance.js";

describe("ACP provider maintenance", () => {
  it.each([
    ["2026.03.07-acde123", "2026.03.07-acde123"],
    ["Cursor 2026.03.17-acde123", "2026.03.17-acde123"],
    ["2026.11.07-acde123", "2026.11.07-acde123"],
    ["v2.1.0-beta.3", "2.1.0-beta.3"],
    ["no version available", null],
    ["2026.00.07-acde123", null],
    ["2026.03.00-acde123", null],
    ["2026.03.07-acde123-extra", null],
    ["2026.03.07-acde123.4", null],
    ["1.2.3-beta..1", null],
  ])(
    "reports installed and health versions for %s",
    async (output, version) => {
      const directory = await mkdtemp(path.join(tmpdir(), "sandy-acp-version-"));
      try {
        const script = path.join(directory, "version.cjs");
        await writeFile(
          script,
          `require("node:fs").readFileSync(0); console.log(${JSON.stringify(output)});`,
        );
        const command = path.join(
          directory,
          process.platform === "win32" ? "version.cmd" : "version",
        );
        await writeFile(
          command,
          process.platform === "win32"
            ? `@echo off\r\n"${process.execPath}" "%~dp0version.cjs" %*\r\n`
            : `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${script.replaceAll("'", "'\\''")}' "$@"\n`,
          { mode: 0o755 },
        );
        expect(
          await getAcpProviderInstallationStatus({
            command,
            maintenance: CURSOR_ACP_MAINTENANCE,
          }),
        ).toMatchObject({
          installed: true,
          currentVersion: version,
          versionUnsupported: false,
        });
        expect(
          await getAcpProviderHealth({ command, maintenance: undefined }),
        ).toMatchObject({
          supported: true,
          health: { status: "ready", installedVersion: version },
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it("normalizes Cursor plan and spend limits without reading daemon state", () => {
    expect(
      __testing.normalizeUsage(
        {
          billingCycleEnd: "1767225600000",
          planUsage: { totalPercentUsed: 72.2 },
          spendLimitUsage: {
            overallUsed: "1250",
            overallLimit: "5000",
          },
        },
        { planInfo: { planName: "Pro" } },
        "cursor@example.com",
      ),
    ).toEqual({
      status: "ok",
      accountEmail: "cursor@example.com",
      planLabel: "Pro",
      windows: [
        {
          label: "Plan usage",
          usedPercent: 72,
          resetsAt: "2026-01-01T00:00:00.000Z",
        },
        {
          label: "On-demand spend",
          usedPercent: 25,
          resetsAt: "2026-01-01T00:00:00.000Z",
          cost: { usedUsdCents: 1250, limitUsdCents: 5000 },
        },
      ],
    });
  });
});

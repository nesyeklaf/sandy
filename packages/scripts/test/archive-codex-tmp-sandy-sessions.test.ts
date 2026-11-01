import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildMatchingThreadIdsSql,
  buildMatchingThreadPreviewSql,
  escapeSqlString,
  parseArchiveTmpSandySessionsArgs,
  parseThreadPreviewRows,
  resolveCodexStateDbPath,
} from "../src/commands/archive-codex-tmp-sandy-sessions.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { force: true, recursive: true });
  }
});

describe("archive-codex-tmp-sandy-sessions", () => {
  it("defaults to archiving sandy test temp dirs from ~/.codex", () => {
    const parsedArgs = parseArchiveTmpSandySessionsArgs(
      [],
      { CODEX_BIN: "/custom/codex" },
      "/Users/tester",
    );

    expect(parsedArgs.help).toBe(false);
    expect(parsedArgs.options).toEqual({
      codexBin: "/custom/codex",
      codexHome: path.resolve("/Users/tester", ".codex"),
      concurrency: 25,
      dryRun: false,
      patterns: [
        "*/sandy-standalone-*",
        "*/sandy-integration-*",
        "*/sandy-integ-*",
        "*/sandy-qa-smoke-*",
      ],
      yes: false,
    });
  });

  it("respects CODEX_HOME when choosing the default Codex state directory", () => {
    const parsedArgs = parseArchiveTmpSandySessionsArgs(
      [],
      { CODEX_HOME: "~/custom-codex" },
      "/Users/tester",
    );

    expect(parsedArgs.options.codexHome).toBe(
      path.resolve("/Users/tester", "custom-codex"),
    );
  });

  it("parses explicit cleanup options", () => {
    const parsedArgs = parseArchiveTmpSandySessionsArgs(
      [
        "--",
        "--dry-run",
        "--yes",
        "--pattern",
        "/tmp/custom-sandy-*",
        "--codex-home=~/custom-codex",
        "--codex-bin",
        "~/bin/codex",
        "--concurrency=7",
      ],
      {},
      "/Users/tester",
    );

    expect(parsedArgs.options).toEqual({
      codexBin: path.join("/Users/tester", "bin", "codex"),
      codexHome: path.resolve("/Users/tester", "custom-codex"),
      concurrency: 7,
      dryRun: true,
      patterns: ["/tmp/custom-sandy-*"],
      yes: true,
    });
  });

  it("accumulates repeated --pattern flags and replaces the defaults", () => {
    const parsedArgs = parseArchiveTmpSandySessionsArgs(
      ["--pattern", "*/sandy-foo-*", "--pattern=*/sandy-bar-*"],
      {},
      "/Users/tester",
    );

    expect(parsedArgs.options.patterns).toEqual(["*/sandy-foo-*", "*/sandy-bar-*"]);
  });

  it("rejects unknown or incomplete options", () => {
    expect(() => parseArchiveTmpSandySessionsArgs(["--wat"], {}, "/tmp")).toThrow(
      "Unknown option: --wat",
    );
    expect(() =>
      parseArchiveTmpSandySessionsArgs(["--pattern"], {}, "/tmp"),
    ).toThrow("Missing value for --pattern");
    expect(() =>
      parseArchiveTmpSandySessionsArgs(["--concurrency", "0"], {}, "/tmp"),
    ).toThrow("--concurrency must be a positive integer");
  });

  it("resolves the highest numbered Codex state DB", () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    tempDirs.push(codexHome);
    writeFileSync(path.join(codexHome, "state_4.sqlite"), "");
    writeFileSync(path.join(codexHome, "state_4.sqlite-wal"), "");
    writeFileSync(path.join(codexHome, "state_5.sqlite"), "");
    writeFileSync(path.join(codexHome, "state_5.sqlite.backup-old"), "");

    expect(resolveCodexStateDbPath(codexHome)).toBe(
      path.join(codexHome, "state_5.sqlite"),
    );
  });

  it("reports when no Codex state DB exists", () => {
    const codexHome = mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    tempDirs.push(codexHome);

    expect(() => resolveCodexStateDbPath(codexHome)).toThrow(
      `No Codex state DB found in ${codexHome}`,
    );
  });

  it("escapes SQLite string values used in generated queries", () => {
    expect(escapeSqlString("/tmp/sandy-o'clock-*")).toBe("/tmp/sandy-o''clock-*");
    expect(buildMatchingThreadIdsSql(["/tmp/sandy-o'clock-*"])).toContain(
      "archived=0 AND (cwd GLOB '/tmp/sandy-o''clock-*')",
    );
    expect(buildMatchingThreadPreviewSql(["/tmp/sandy-*"])).toContain(
      "ORDER BY updated_at DESC LIMIT 10",
    );
  });

  it("ORs multiple GLOB patterns in the WHERE clause", () => {
    const sql = buildMatchingThreadIdsSql([
      "*/sandy-standalone-*",
      "*/sandy-integration-*",
      "*/sandy-integ-*",
    ]);
    expect(sql).toContain(
      "archived=0 AND (cwd GLOB '*/sandy-standalone-*' OR cwd GLOB '*/sandy-integration-*' OR cwd GLOB '*/sandy-integ-*')",
    );
  });

  it("parses sqlite preview rows", () => {
    const separator = "\u001f";
    const rows = parseThreadPreviewRows(
      [
        ["thr_1", "2026-04-15 13:40:15", "/tmp/sandy-integ-one"].join(separator),
        ["thr_2", "2026-04-15 13:39:51", "/tmp/sandy-integration-two"].join(
          separator,
        ),
      ].join("\n"),
    );

    expect(rows).toEqual([
      {
        cwd: "/tmp/sandy-integ-one",
        id: "thr_1",
        updatedAt: "2026-04-15 13:40:15",
      },
      {
        cwd: "/tmp/sandy-integration-two",
        id: "thr_2",
        updatedAt: "2026-04-15 13:39:51",
      },
    ]);
  });
});

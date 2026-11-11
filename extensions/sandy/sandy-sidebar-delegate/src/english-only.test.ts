import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED_ENTRIES = ["src", "app.tsx", "README.md", "CHANGELOG.md", "skills"];
const SCANNED_EXTENSIONS = [".ts", ".tsx", ".md", ".css", ".json"];
const FILES_SCANNED_MAX = 5000;
const DIRECTORIES_SCANNED_MAX = 1000;
const GERMAN_CHARACTERS = /[äöüÄÖÜß]/;
const GERMAN_WORDS = [
  "Orchestratoren",
  "Idee",
  "Ideen",
  "Lädt",
  "Thema",
  "Themen",
  "nicht",
  "oder",
  "und",
  "keine",
  "kein",
  "für",
  "über",
  "Sitzung",
  "Sitzungen",
  "Fehler",
  "Speichern",
  "Löschen",
  "Abbrechen",
  "Fertig",
  "Erneut",
  "versuchen",
  "entfernen",
  "markieren",
  "dieser",
  "konnten",
  "geladen",
  "Bereichen",
  "Einstellungen",
  "Zurück",
];
const GERMAN_WORD_PATTERN = new RegExp(`(?<![\\p{L}])(${GERMAN_WORDS.join("|")})(?![\\p{L}])`, "iu");

function isExcluded(path: string): boolean {
  const isTest = /\.test\.[a-z]+$/.test(path);
  const isFixture = path.includes(`src/fixtures/`) || path.includes("/screenshots/");
  const isHelper = /(^|\/)test-[^/]+$/.test(path);
  return isTest || isFixture || isHelper;
}

function collectFiles(): string[] {
  const files: string[] = [];
  const pending = SCANNED_ENTRIES.map((entry) => join(PLUGIN_ROOT, entry));
  let directoriesScanned = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) throw new Error("scan stack emptied unexpectedly");
    let status;
    try {
      status = statSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (status.isDirectory()) {
      directoriesScanned += 1;
      if (directoriesScanned > DIRECTORIES_SCANNED_MAX) throw new Error("too many directories scanned");
      for (const name of readdirSync(current)) pending.push(join(current, name));
    } else if (SCANNED_EXTENSIONS.some((extension) => current.endsWith(extension))) {
      files.push(relative(PLUGIN_ROOT, current));
      if (files.length > FILES_SCANNED_MAX) throw new Error("too many files scanned");
    }
  }
  return files.filter((file) => !isExcluded(file)).sort();
}

function germanLineNumbers(text: string): number[] {
  const numbers: number[] = [];
  text.split("\n").forEach((line, index) => {
    if (GERMAN_CHARACTERS.test(line) || GERMAN_WORD_PATTERN.test(line)) numbers.push(index + 1);
  });
  return numbers;
}

function findGermanText(files: readonly string[]): string[] {
  return files.flatMap((file) =>
    germanLineNumbers(readFileSync(join(PLUGIN_ROOT, file), "utf8")).map((line) => `${file}:${line}`),
  );
}

describe("English-only plugin text", () => {
  it("finds no German text in source, app entry, README or skills", () => {
    const files = collectFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(findGermanText(files)).toEqual([]);
  });

  it("flags German words and characters by line and ignores English text", () => {
    const text = ['const label = "Open";', 'const shelf = "Orchestratoren";', "// Größe", "Ideas and more"].join("\n");
    expect(germanLineNumbers(text)).toEqual([2, 3]);
  });
});

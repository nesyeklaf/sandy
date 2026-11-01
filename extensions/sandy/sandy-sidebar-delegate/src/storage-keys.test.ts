import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { expect, it } from "vitest";
import { BROWSER_EVENTS } from "./lib/browser-events";
import { PLUGIN_STORAGE_KEYS, STORAGE_KEYS } from "./lib/storage-keys";

// Golden fixtures and tests retain literal keys as compatibility evidence.
const sources = [
  "app.tsx",
  ...readdirSync("src", { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.test\./.test(file) && !basename(file).startsWith("test-"))
    .map((file) => `src/${file}`),
]
  .sort()
  .map((file) => ({ file, content: readFileSync(file, "utf8") }));

it("declares every production storage key once in the registry", () => {
  const occurrences = sources.flatMap(({ file, content }) =>
    [...content.matchAll(/["'`]sandy-sidebar:[\w:-]+["'`]/g)].map((match) => ({
      file,
      key: match[0].slice(1, -1),
    })),
  );
  const events = new Set<string>(Object.values(BROWSER_EVENTS));
  const storage = occurrences.filter(({ key }) => !events.has(key));
  expect(storage.map(({ key }) => key).sort()).toEqual(
    Object.values(STORAGE_KEYS)
      .map(({ key }) => key)
      .sort(),
  );
  expect(storage.every(({ file }) => file === "src/lib/storage-keys.ts")).toBe(true);
  expect(occurrences.filter(({ key }) => events.has(key))).toEqual(
    Object.values(BROWSER_EVENTS).map((key) => ({ file: "src/lib/browser-events.ts", key })),
  );
  expect(new Set(PLUGIN_STORAGE_KEYS).size).toBe(PLUGIN_STORAGE_KEYS.length);
  expect(PLUGIN_STORAGE_KEYS).toEqual(
    Object.values(STORAGE_KEYS)
      .sort((a, b) => a.evictionPriority - b.evictionPriority)
      .map(({ key }) => key),
  );
});

it("keeps storage and event key construction inside their registries", () => {
  const registries = new Set(["src/lib/storage-keys.ts", "src/lib/browser-events.ts"]);
  // Match the prefix alone so interpolation and concatenation cannot hide a key.
  const unexpected = sources
    .filter(({ file }) => !registries.has(file))
    .flatMap(({ file, content }) =>
      [...content.matchAll(/["'`]sandy-sidebar:/g)].map(
        (match) => `${file}:${content.slice(0, match.index).split("\n").length}`,
      ),
    );
  expect(unexpected).toEqual([]);
});

it("keeps production browser storage access inside the shared storage helpers", () => {
  const accesses = sources.filter(({ content }) => /localStorage|sessionStorage/.test(content)).map(({ file }) => file);
  expect(accesses).toEqual(["src/lib/safe-storage.ts", "src/lib/storage-codec.ts"]);
});

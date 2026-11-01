import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import * as testIcons from "./test-icon-data";

it("keeps test icon data identical to the ESM package entry", async () => {
  const requireForTests = createRequire(import.meta.url);
  const packageFile = requireForTests.resolve("@hugeicons/core-free-icons/package.json");
  const esmEntry = pathToFileURL(join(dirname(packageFile), "dist/esm/index.js"));
  const esmIcons = (await import(esmEntry.href)) as Record<string, unknown>;
  const source = readFileSync(new URL("./components/Icon.tsx", import.meta.url), "utf8");
  const names = source
    .match(/\{([^{}]+)\}\s*from "@hugeicons\/core-free-icons";/)![1]!
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  expect(names.length).toBeGreaterThan(0);
  expect(Object.keys(testIcons).sort()).toEqual([...names].sort());
  for (const name of names) {
    expect(esmIcons[name]).toBeDefined();
    expect((testIcons as Record<string, unknown>)[name]).toEqual(esmIcons[name]);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { toUnifiedPatch } from "./diff-patch.ts";

test("converts pi's line diff into a unified patch with consistent counts", () => {
  const diff = ["@@ 3 @@", " 3 a", " 4 b", "-5 old", "+5 new1", "+6 new2", " 6 c", "...", " 20 x", "-21 y", "  22 z"].join("\n");
  const patch = toUnifiedPatch(diff, "src/a.ts")!;
  assert.match(patch, /^diff --git a\/src\/a.ts b\/src\/a.ts\n--- a\/src\/a.ts\n\+\+\+ b\/src\/a.ts\n/);
  assert.match(patch, /@@ -3,4 \+3,5 @@\n a\n b\n-old\n\+new1\n\+new2\n c\n/);
  // after the first hunk new = old + 1
  assert.match(patch, /@@ -20,3 \+21,2 @@\n x\n-y\n z\n$/);
});

test("handles padded numbers and a pure insertion", () => {
  const patch = toUnifiedPatch(["+ 7 added", "  8 next"].join("\n"), "f")!;
  assert.match(patch, /@@ -7,1 \+7,2 @@\n\+added\n next\n/);
});

test("returns null without diff lines", () => {
  assert.equal(toUnifiedPatch("", "f"), null);
});

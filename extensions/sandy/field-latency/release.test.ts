import { test } from "node:test";
import assert from "node:assert/strict";
import { appScriptHash, readRelease, releaseKey } from "./release.ts";

test("the hash comes from the main index script, not from chunks", () => {
  assert.equal(appScriptHash(["/assets/vendor-AAAA1111.js", "/assets/index-Bx12Cy34.js"]), "Bx12Cy34");
  assert.equal(appScriptHash(["https://host/app/assets/index-Bx12Cy34.js?v=2"]), "Bx12Cy34");
  assert.equal(appScriptHash(["/assets/vendor-AAAA1111.js", "/static/main.js"]), null);
});

test("the release key joins version and hash, and falls back to whichever exists", () => {
  assert.equal(releaseKey({ sandyVersion: "0.49.1", appScript: "Bx12Cy34" }), "0.49.1+Bx12Cy34");
  assert.equal(releaseKey({ sandyVersion: null, appScript: "Bx12Cy34" }), "Bx12Cy34");
  assert.equal(releaseKey({ sandyVersion: "0.49.1", appScript: null }), "0.49.1");
  assert.equal(releaseKey({ sandyVersion: null, appScript: null }), "unknown");
});

test("readRelease reads the sandy-version meta tag and the module script sources", () => {
  const doc = {
    querySelector: (selector: string) => (selector.includes("sandy-version") ? { getAttribute: () => " 0.49.1 " } : null),
    querySelectorAll: () => [{ getAttribute: () => "/assets/index-Zz99.js" }],
  } as unknown as Parameters<typeof readRelease>[0];
  assert.deepEqual(readRelease(doc), { sandyVersion: "0.49.1", appScript: "Zz99" });
  const bare = { querySelector: () => null, querySelectorAll: () => [] } as unknown as Parameters<typeof readRelease>[0];
  assert.deepEqual(readRelease(bare), { sandyVersion: null, appScript: null });
});

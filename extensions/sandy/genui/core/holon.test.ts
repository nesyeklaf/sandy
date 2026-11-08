import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dataKey, type LoadedData } from "./data";
import { LIGHTS, readHolonView } from "./holon";
import { compile, evaluate, formatDiagnostics, initialState, toMarkdown } from "./index";
import type { Value } from "./types";

const fixture = (name: string): Value => JSON.parse(readFileSync(new URL(`../gallery/data/holon/${name}.json`, import.meta.url), "utf8")) as Value;

function markdown(name: string): string {
  const result = compile(`Holon(Load("view.json"))`);
  if (result.program === null) throw new Error(formatDiagnostics(result.diagnostics));
  const data = new Map<string, LoadedData>([[dataKey({ path: "view.json", raw: false }), { ok: true, value: fixture(name) } as LoadedData]]);
  return toMarkdown(evaluate(result.program, initialState(result.program, data), data).roots);
}

describe("readHolonView", () => {
  it.each(["view-account", "view-password-reset", "view-sign-in"])("reads %s as given", (name) => {
    const read = readHolonView(fixture(name));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.view.focus.title).not.toBe("");
  });

  it("keeps the light, drift and counts the extension computed", () => {
    const read = readHolonView(fixture("view-password-reset"));
    if (!read.ok) throw new Error(read.error);
    expect(read.view.focus.light).toBe("drift");
    expect(read.view.focus.driftBelow).toBe(3);
    expect(read.view.focus.drift).toEqual([{ kind: "expired", side: "They", seam: null, detail: "Expired on 2026-07-30" }]);
    expect(read.view.focus.sides.They.light).toBe("expired");
    expect(read.view.children.map((child) => child.title)).toEqual(["Reset mail", "Reset rate limit", "Reset token"]);
  });

  it.each([
    ["nothing", undefined, "needs a holon-view/v0 object"],
    ["a string", "not a view", "view should be an object"],
    ["a list", [], "view should be an object"],
    ["another format", { format: "holon/v0" }, 'format should be "holon-view/v0" (got "holon/v0")'],
    ["no format", {}, 'format should be "holon-view/v0" (got none)'],
    ["no focus", { format: "holon-view/v0" }, "focus should be an object"],
  ])("answers %s with a plain error", (_label, value, message) => {
    const read = readHolonView(value as Value | undefined);
    expect(read).toEqual({ ok: false, error: expect.stringContaining(message) });
  });

  it("names the path of the first wrong field", () => {
    const view = structuredClone(fixture("view-password-reset")) as { focus: { sides: { It: { light: string } } } };
    view.focus.sides.It.light = "green";
    const read = readHolonView(view as unknown as Value);
    expect(read).toEqual({ ok: false, error: expect.stringContaining("focus.sides.It.light should be one of hard, soft, claimed, open, refuted, expired") });
  });

  it("rejects a seam drift kind it does not know", () => {
    const view = structuredClone(fixture("view-account")) as { seams: { drift: string | null }[] };
    view.seams[0].drift = "mystery";
    const read = readHolonView(view as unknown as Value);
    expect(read).toEqual({ ok: false, error: expect.stringContaining("seams[0].drift should be one of") });
  });

  it("gives every light a distinct glyph or tone", () => {
    expect(Object.keys(LIGHTS).sort()).toEqual(["claimed", "drift", "expired", "hard", "open", "refuted", "soft"]);
    expect(LIGHTS.hard.glyph).toBe("●");
    expect(LIGHTS.refuted.tone).toBe("bad");
  });
});

describe("toMarkdown: Holon", () => {
  it("writes the focus with Why, Contract, the four sides, drift, code, parts and seams", () => {
    const out = markdown("view-password-reset");
    expect(out).toContain("◇ **Password reset** · component · active · 3 drift below");
    expect(out).toContain("Part of ◇ Account service · container · 4 drift below");
    expect(out).toContain("**Why** A forgotten password should not turn into a support ticket.");
    expect(out).toContain("- ○ **I** open — Declared, never checked");
    expect(out).toContain("- ● **It** hard — 14 tests passed, including expiry and reuse _(ci · apps/account/reset.test.ts");
    expect(out).toContain("- ◇ **They** expired — Expired on 2026-07-30");
    expect(out).toContain("- ◇ **expired** (side They): Expired on 2026-07-30");
    expect(out).toContain("**Code** `apps/account/reset.ts`");
    expect(out).toContain("- ◇ Reset rate limit · function · proposed · 1 drift below");
    expect(out).toContain("- Password reset → Mail ●: Sends only to verified addresses");
  });

  it("marks a seam with drift and an exclusive promise", () => {
    const out = markdown("view-account");
    expect(out).toMatch(/exclusive/);
    expect(out).toMatch(/drift: contradiction/);
  });

  it("answers a wrong view with its error, not a crash", () => {
    const result = compile(`Holon(Load("view.json"))`);
    const data = new Map<string, LoadedData>([[dataKey({ path: "view.json", raw: false }), { ok: true, value: { format: "other" } } as LoadedData]]);
    expect(toMarkdown(evaluate(result.program!, initialState(result.program!, data), data).roots)).toContain('_(Holon: format should be "holon-view/v0"');
  });
});

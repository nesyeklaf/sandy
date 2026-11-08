import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { confirmationPath, parseConfirmation, parseEvidenceLines, parseHolon } from "./format.ts";
import { readConfirmationFile } from "./model.ts";
import { contractHash } from "./time.ts";
import { SHOP } from "../test/fixture.ts";

const resetToken = JSON.parse(readFileSync(join(SHOP, "apps/account/reset-token.holon"), "utf8")) as Record<string, unknown>;

describe("confirmation file names", () => {
  const base = { holon: "login", at: "2026-11-08" };

  it("turns every : into _ so Windows can check the file out", () => {
    expect(confirmationPath({ ...base, side: "seam:mail", by: "agent:claude" })).toBe(".holons/confirmations/login/2026-11-08-seam_mail-agent_claude.json");
    expect(confirmationPath({ ...base, side: "I", by: "maria" })).toBe(".holons/confirmations/login/2026-11-08-I-maria.json");
  });

  it("reads side and by from the JSON of an escaped file name", () => {
    const confirmation = {
      format: "holon-confirmation/v0", ...base, side: "seam:mail", by: "agent:x", recordedBy: "agent:x",
      expires: "2027-02-06", contractHash: contractHash("Mail arrives"), answer: "Works", hesitation: [], result: "confirmed",
    };
    const read = readConfirmationFile(".holons/confirmations/login/2026-11-08-seam_mail-agent_x.json", JSON.stringify(confirmation));
    expect(read.error).toBeNull();
    expect(read.confirmation).toMatchObject({ side: "seam:mail", by: "agent:x" });
    const literal = readConfirmationFile(".holons/confirmations/login/2026-11-08-seam:mail-agent:x.json", JSON.stringify(confirmation));
    expect(literal.error).toContain("2026-11-08-seam_mail-agent_x.json");
  });
});

describe("unpaired surrogates", () => {
  const unpaired = { ok: false, error: "invalid JSON: unpaired surrogate in a string" };
  const holonText = JSON.stringify(resetToken);

  it.each([
    ["a value", holonText.replace(/"title":"[^"]*"/, String.raw`"title":"a\ud800b"`)],
    ["a trailing half", holonText.replace(/"title":"[^"]*"/, String.raw`"title":"\udc00"`)],
    ["a key", holonText.replace(/^\{/, String.raw`{"\ud800":1,`)],
    ["a nested array item", holonText.replace(/"carriedBy":\[[^\]]*\]/, String.raw`"carriedBy":[["\ud83d"]]`)],
  ])("rejects a holon with one in %s", (_where, text) => {
    expect(text).toMatch(/\\ud[89a-f]/);
    expect(parseHolon(text)).toEqual(unpaired);
  });

  it("accepts a surrogate pair", () => {
    const parsed = parseHolon(holonText.replace(/"title":"[^"]*"/, String.raw`"title":"\ud83c\udf89"`));
    expect(parsed.ok && parsed.value.title).toBe("🎉");
  });

  it("rejects a confirmation with one", () => {
    expect(parseConfirmation(String.raw`{"format":"holon-confirmation/v0","answer":"\ud800"}`)).toEqual(unpaired);
  });

  it("rejects an evidence line with one", () => {
    expect(parseEvidenceLines(`\n${String.raw`{"holon":"a","detail":"\udfff"}`}\n`)).toEqual({ ok: false, error: `line 2: ${unpaired.error}` });
  });

  it("reports a syntax error before an unpaired surrogate", () => {
    const parsed = parseHolon(String.raw`{"a":"\ud800",}`);
    expect(parsed.ok || parsed.error).toMatch(/^invalid JSON: (?!unpaired)/);
  });
});

describe("holon kind vocabulary", () => {
  it("accepts operation", () => {
    const parsed = parseHolon(JSON.stringify(resetToken));
    expect(parsed.ok && parsed.value.kind).toBe("operation");
  });

  it.each(["function", "node", "action", "binding", "service"])("rejects %s like any unknown kind", (kind) => {
    const parsed = parseHolon(JSON.stringify({ ...resetToken, kind }));
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toContain("kind");
  });
});

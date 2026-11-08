import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { confirmationPath, parseHolon } from "./format.ts";
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

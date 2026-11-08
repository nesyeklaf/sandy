import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHolon } from "./format.ts";
import { SHOP } from "../test/fixture.ts";

const resetToken = JSON.parse(readFileSync(join(SHOP, "apps/account/reset-token.holon"), "utf8")) as Record<string, unknown>;

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

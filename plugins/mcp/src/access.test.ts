import { describe, expect, it } from "vitest";
import { mcpAccessProblem } from "./access.js";

function problem(headers: Record<string, string>) {
  return mcpAccessProblem(new Headers(headers));
}

describe("mcpAccessProblem", () => {
  it("lets a caller without an origin through", () => {
    expect(problem({})).toBeNull();
  });

  it("refuses a request that comes from a web page", () => {
    expect(problem({ origin: "https://evil.example" })).toMatchObject({
      status: 403,
    });
    expect(problem({ origin: "http://127.0.0.1:38886" })).toMatchObject({
      status: 403,
    });
  });

  it("gives the old gate OAuth headers no access of their own", () => {
    expect(
      problem({
        origin: "https://evil.example",
        "x-sandy-gate-auth": "oauth",
        "x-sandy-gate-oauth-scope": "sandy",
      }),
    ).toMatchObject({ status: 403 });
  });
});

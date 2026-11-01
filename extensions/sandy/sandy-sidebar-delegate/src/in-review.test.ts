import { describe, expect, it } from "vitest";
import type { EnvironmentPullRequest } from "./github-pr-status";
import { isInReview } from "./in-review";

const pr = (state: EnvironmentPullRequest["state"]): EnvironmentPullRequest => ({
  number: 1,
  title: "t",
  url: "https://github.com/o/r/pull/1",
  state,
  attention: "none",
  updatedAt: "2026-10-31T00:00:00Z",
});
const thread = (environmentId?: string) => ({
  environment: environmentId ? ({ id: environmentId } as never) : null,
});

describe("isInReview", () => {
  it("is true for an open pull request on the thread's environment", () => {
    expect(isInReview(thread("env_1"), new Map([["env_1", pr("open")]]))).toBe(true);
  });
  it.each(["draft", "merged", "closed"] as const)("is false for a %s pull request", (state) => {
    expect(isInReview(thread("env_1"), new Map([["env_1", pr(state)]]))).toBe(false);
  });
  it("is false without a pull request or an environment", () => {
    expect(isInReview(thread("env_1"), new Map())).toBe(false);
    expect(isInReview(thread(), new Map([["env_1", pr("open")]]))).toBe(false);
  });
});

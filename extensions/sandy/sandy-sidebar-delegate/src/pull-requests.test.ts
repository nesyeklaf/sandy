import { describe, expect, it } from "vitest";
import { createdPullRequestUrls, parseGhPullRequest } from "./pull-requests";
import { mergeThreadPullRequests } from "./pull-request-display";

function command(command: string, aggregatedOutput: string, type = "item/completed") {
  return { type, data: { item: { type: "commandExecution", command, aggregatedOutput } } };
}

describe("createdPullRequestUrls", () => {
  it("collects PRs printed by gh pr create, oldest first and without repeats", () => {
    expect(
      createdPullRequestUrls([
        command(
          "git push -u origin a && gh pr create --fill",
          "remote: Create a pull request for 'a' on GitHub by visiting:\nremote:   https://github.com/o/r/pull/new/a\nhttps://github.com/o/r/pull/12",
        ),
        command(
          "gh pr create --base main",
          'a pull request for branch "b" into branch "main" already exists:\nhttps://github.com/o/r/pull/13',
        ),
        command("gh  pr   create", "https://github.com/o/r/pull/12"),
      ]),
    ).toEqual(["https://github.com/o/r/pull/12", "https://github.com/o/r/pull/13"]);
  });

  it("finds gh pr create wherever a shell runs it", () => {
    const url = (number: number) => `https://github.com/o/r/pull/${number}`;
    expect(
      createdPullRequestUrls([
        command('/bin/zsh -lc "gh pr create --base main"', url(1)),
        command("/bin/zsh -c 'gh pr create --fill'", url(2)),
        command("git push -u origin a\n gh pr create -R o/r", url(3)),
        command(
          "cat > body.md <<'EOF'\nText\nEOF\ngit push && GH_PROMPT_DISABLED=1 /opt/homebrew/bin/gh pr create",
          url(4),
        ),
        command("url=$(gh pr create --fill); echo $url", url(5)),
      ]),
    ).toEqual([1, 2, 3, 4, 5].map(url));
  });

  it("ignores commands that only mention gh pr create", () => {
    expect(
      createdPullRequestUrls([
        command('sandy thread search "gh pr create" --json', "https://github.com/o/r/pull/1"),
        command(
          "sandy thread log thr_a --json | python3 -c \"\nif 'gh pr create' in s: print(s)\"",
          "https://github.com/o/r/pull/2",
        ),
        command("grep -rn 'opened with `gh pr create`' CHANGELOG.md", "https://github.com/o/r/pull/3"),
      ]),
    ).toEqual([]);
  });

  it("ignores PRs a thread only read about", () => {
    expect(
      createdPullRequestUrls([
        command("gh pr view 7", "https://github.com/o/r/pull/7"),
        command("gh pr create", "https://github.com/o/r/pull/8", "item/started"),
        {
          type: "item/completed",
          data: { item: { type: "agentMessage", text: "Opened https://github.com/o/r/pull/9" } },
        },
        { type: "item/completed", data: null },
      ]),
    ).toEqual([]);
  });
});

describe("parseGhPullRequest", () => {
  it("maps gh states onto the sidebar's", () => {
    const view = (state: string, isDraft = false) =>
      parseGhPullRequest(
        JSON.stringify({ number: 4, title: "Fix", state, isDraft, url: "https://github.com/o/r/pull/4" }),
      )?.state;
    expect(view("OPEN")).toBe("open");
    expect(view("OPEN", true)).toBe("draft");
    expect(view("MERGED")).toBe("merged");
    expect(view("CLOSED")).toBe("closed");
    expect(parseGhPullRequest("not json")).toBeNull();
  });
});

describe("mergeThreadPullRequests", () => {
  const current = {
    number: 3,
    title: "Live",
    url: "u3",
    state: "open" as const,
    attention: "checks_pending" as const,
    updatedAt: "2026-10-23T12:00:00Z",
  };

  it("keeps history order and uses the live PR's status in place", () => {
    const history = [
      { url: "u4", number: 4, title: "Newer", state: "merged" as const },
      { url: "u3", number: 3, title: "Live", state: "open" as const },
    ];
    expect(mergeThreadPullRequests(current, history, false)).toEqual([history[0], current]);
    expect(mergeThreadPullRequests(null, history, true)).toEqual(history);
  });

  it("leads with an unknown live PR only in the thread's own worktree", () => {
    const history = [{ url: "u2", number: 2, title: null, state: null }];
    expect(mergeThreadPullRequests(current, history, true)).toEqual([current, history[0]]);
    // A shared checkout's branch PR can belong to any thread working in it.
    expect(mergeThreadPullRequests(current, history, false)).toEqual(history);
  });
});

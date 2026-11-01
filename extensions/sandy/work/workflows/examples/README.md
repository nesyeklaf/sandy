# Example workflows

`optimize-tests.js` is the end-to-end run that proved reusable worker sessions (run `wfr_be9a550d`): one frontend and one backend test file are optimized in parallel. Each worker starts with the raw prompt `/autopilot --report <kind>-tests <repo> <file>`, so the pi autopilot from `pi/autopilot/autopilots` measures without a model turn. A reviewer judges the report, and a rejected worker continues in its own session (`agent(prompt, {session})`) for at most two rounds.

`ship.js` runs the pi autopilot `ship` (`pi/autopilot/autopilots/ship.ts`) in two workers in parallel, each an autopilot that steers its own session with `step()`: the review worker gets read-only tools and submits findings, code keeps only findings on changed files; the release worker gets no tools and writes notes from the commit log code collected. Both calls use `raw: true, report: true`, so the call ends on the autopilot's reported value and not after its first turn. Args: `{base?: "origin/main", from?: "<tag>"}`; without args the review covers the uncommitted changes and the notes the commits since the last tag.

`optimize-tests.js` args: `{repo: "/tmp/<throwaway copy>", targets: [{kind: "frontend" | "backend", file}]}`. The autopilots refuse a repo outside `/tmp`.

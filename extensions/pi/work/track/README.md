# track-guard

pi extension that hard-gates the main agent by the current stage of a SANDY track run. It is a `tool_call` handler
that reads the thread's policy file (contract: `sandy/work/track/POLICY.md`):

    ${TRACK_STATE_DIR:-~/.local/state/sandy-track}/threads/$SANDY_THREAD_ID.json

No `SANDY_THREAD_ID` in the environment, no file, or `active: false`: everything is allowed (no-op outside stage runs).
The file is re-read on each call (cached by mtime/size/inode).

## What it blocks

- tools in `allow.denyTools` (exact name or suffix after `__`)
- `read` of / `bash` mentioning `skills/<name>/SKILL.md` for a skill not in `allow.skills`
- `edit`/`write` when `allow.edits === false`, except targets under `$SANDY_THREAD_STORAGE` or `/tmp`
- always (while active): `edit`/`write` of `stages.json` inside a `skills/` directory, and anything under the state dir
- launches that match no `allow.subagents` pattern (`*` globs; a pattern `model` needs the launch to name a model):
  `subagent` (top level, `tasks[]`, `chain[]` incl. nested `parallel`/`tasks`), `sandy_delegate` (its `agent` and `model`;
  no `model` = no model named, as for `subagent`) and `sandy_workflow_plus_run`/`sandy_workflow_run` (agents named inside a
  script cannot be matched: one unmatched launch `(workflow)`). Calls without any `agent` (`subagent` status/list) and
  `sandy_delegate_send`/`_wait`/`_status`/`_stop` are management and pass

Always allowed: `*stage_(start|status|submit|advance|propose_force)` tools, `*autopilot_submit` (pi/autopilot's step
answer) and `sandy work track ...` bash commands.

## Lease ticket

The guard also carries the agent's lease ticket (sandy/work/track/docs/design-v2.md §8): it takes it from the policy file when
an agent turn starts (if the agent drives) and from the terminal `⟦track-ticket⟧ <ticket>` line of `stage_start`/`stage_advance` results (only the last line; the
plugin removes the marker everywhere else),
and writes it into every `stage_submit`, `stage_advance` and `stage_propose_force` call, top level or nested in codemode,
overwriting what the model typed. On capture it appends a `track-lease` session entry; `stage_submit` and `stage_advance`
also get the tokens the session used since that entry (`usage`, left out when pi cannot measure them). That code lives in
`pi/autopilot/usage.ts` and is imported by relative path, so this extension and pi/autopilot must be installed from the
same checkout (`scripts/install-pi.sh` does; docs/decisions in sandy/work/track).

The guard is also the usage meter of every `track-lease` marker in its session (agent or autopilot runner alike), late and
read-only (sandy/work/track decisions D19): when a turn ends or starts and the newest marker is no longer the policy file's current
ticket, it reports that lease's measured tokens with `sandy work track usage --ticket <t> --usage <json>` (`SANDY_CLI` picks the
binary; a failure is logged and dropped) and appends an end marker (`track-lease` with `ticket: null`), so later work
belongs to no lease. The report completes the closed lease's usage (the closing reply after `stage_advance`, an owner
abort); it never moves the track.
An unreadable or off-contract file fails closed for skills, edits and subagent/`sandy_delegate`/workflow launches; other tools pass.

## Install

`scripts/install-pi.sh` links this directory to `~/.pi/agent/extensions/track-guard`. Tests: `npm test`
(`node --test --experimental-strip-types tests/*.test.ts`).

## Stricter readings chosen where POLICY.md is ambiguous

- `sandy work track` bash is exempt only when it is a single simple command: an unquoted `;`, `&`, `|`, newline, backtick,
  `$(` or `<<` makes it fall through to the normal rules (so `sandy work track x; cat skills/y/SKILL.md` is not a bypass).
  Consequence: a heredoc `sandy work track submit <<EOF` is subject to `denyTools: ["bash"]`; pass submit text via a file instead.
- The old spelling `sandy track ...` is exempt under the same rule until the standalone track plugin is gone.
- Tool names `edit`/`write`/`read`/`bash`/`subagent`/`sandy_delegate`/`sandy_workflow_plus_run`/`sandy_workflow_run` also match as `*__<name>` suffixes.
- `edit`/`write` without a `path`/`file_path` is blocked while `edits: false`; paths are resolved (`..`, `~`, symlinks of the
  deepest existing ancestor) and must be in an allowed root both lexically and after symlink resolution.
- `stages.json` is protected when any ancestor directory is named `skills`.
- Policy file errors (also bad types, `version !== 1`) are treated like invalid JSON: skills all blocked, edits blocked except
  `/tmp`/`$SANDY_THREAD_STORAGE`, the state dir and `stages.json` still protected, subagent launches blocked, management calls pass.
- A subagent call with `workflow` and no `action`, and every `sandy_workflow_plus_run`/`sandy_workflow_run` call, counts as an unmatchable launch: blocked whenever `allow.subagents` is present.
- Calls a `codemode` script makes (`tools.sandy_delegate(...)`) reach the same `tool_call` hook and are gated like top-level ones (sandy/work/track/docs/probes-v2.md (b)); the `codemode` call itself is only subject to `denyTools`.
- Skill name match on `SKILL.md` is case-insensitive.
- Not covered (a hook cannot see inside them): files written via `bash` (e.g. `echo > file`), and skills read by other means.

# Slice 4 live evidence (sandy 0.47.1, plugin SDK 0.6.79), 2026-10-27

Setup (this host only):
- Plugin `delegate@0.1.0` installed from path: `sandy plugin build . && sandy plugin install /home/aemon/projects/plugins-wt/sandy-delegate/sandy/delegate --yes`.
- pi extension copied to `~/.pi/agent/extensions/sandy-delegate/{index.ts (= pi-extension.ts), shared/policy.ts}`.
- Throwaway git repo `/tmp/sandy-delegate-live/repo` (branch `delegate-live`, commit b243466), project `proj_ktxba3f8zg` "[delegate-test] live repo".
- Parents: visible pi threads, anthropic/claude-haiku-5-5, permission full. SANDY gave each parent a worktree environment of the project.

Thread ids (all "[delegate-test]"):
| thread | role | delegation |
|---|---|---|
| thr_pcw8s9ystu | parent 1 (env_zzx3vpp5pu, branch sandy/delegate-test-parent-thr_pcw8s9ystu) | |
| thr_qvjxq2wtxm | scout child | dlg_0c5545cb-7cdc-4bbf-9940-0eafaa537c08 |
| thr_7aff8m3fnh | scout child (gate test) | dlg_89fc011c-62ca-482c-b1f3-c88e3492bf96 |
| thr_e4ejqc24jq | implementer-low child (writer) | dlg_9c1003fb-fa46-4833-b26a-d56608c1e744 |
| thr_9m7s5gdm8n | parent 2 (bind-delay test, env_z4inmqdv7w) | |
| thr_vbnc3ssren | scout child, bind delayed 5 s | dlg_46e6ea09-5cdd-4d50-898c-4f0898e6af57 |

## PI_SANDY_TOOLS_FILE format vs hasDelegateMarker
The bridge writes a JSON array of tool objects with `name`. Child sessions:
`['update_environment_directory', 'AskUserQuestion', 'sandy_delegate_brief', 'stage_start', 'stage_status', 'stage_submit', 'stage_advance', 'sandy_workflow_run']`.
Parent sessions: the same list with `sandy_delegate`, `check_ui`, `ui_examples` and no `sandy_delegate_brief`. So configure gives a delegate only the marker, and a plain thread only `sandy_delegate`.

## Non-delegate threads still work
Both parents are pi threads with the extension loaded and no marker. They called `sandy_delegate` (3 calls on parent 1, 1 call on parent 2) and finished their turns normally. The extension registers nothing without the marker.

## Scout: spawn -> ack -> brief, gated
The parent's sandy_delegate result (thr_pcw8s9ystu, 2nd call):
```json
{"ok":true,"delegationId":"dlg_89fc011c-62ca-482c-b1f3-c88e3492bf96","threadId":"thr_7aff8m3fnh","agent":"scout","agentVersion":1,"status":"starting","model":"anthropic/claude-haiku-5-5","thinking":"medium","reasoningLevel":"medium","permissionMode":"full","workspace":"parent","reused":false}
```
- Child thread: `visibility: hidden`, `parentThreadId: thr_pcw8s9ystu`, `providerId: pi`, `environmentId: env_zzx3vpp5pu` (the parent's environment, reused).
- The bootstrap prompt names only the delegation and `sandy_delegate_brief`. The first tool call returned the role body plus the task.
- Ledger (plugin data.db, read-only): reserved at 1793095929232, bound at …259; policy issued at 1793095930266; ack at …572 with pi_session_id 01a17cd8-…; brief_delivered_at …2155; state active.
- Scout 1 (thr_qvjxq2wtxm), edit and write: neither is an active tool. Codemode answered verbatim `tools.edit does not exist. Available: read, grep, find, ls, sandy_delegate_brief, …, get_goal, create_goal`, and the same for `tools.write`. README.md is unchanged and `/tmp/sandy-delegate-live/scout-wrote.txt` was not created.
- Scout 2 (thr_7aff8m3fnh), a nested call to a tool another extension re-added (`get_goal`, which is not in the allowlist), made via codemode: `ERR sandy-delegate: tool "get_goal" is not in this delegate's allowlist`. This is the tool_call gate itself. (The model refused to call `create_goal`, because its own description says it is for explicit user requests only.)

`sandy delegate list` (parent 1, after the runs):
```
DELEGATION                                STATE   AGENT            PARENT          CHILD           MODEL                       REASONING  ACKED                     BRIEF      CREATED
dlg_9c1003fb-fa46-4833-b26a-d56608c1e744  active  implementer-low  thr_pcw8s9ystu  thr_e4ejqc24jq  anthropic/claude-haiku-5-5  high       2026-10-27T10:14:05.937Z  delivered  2026-10-27T10:14:03.175Z
dlg_89fc011c-62ca-482c-b1f3-c88e3492bf96  active  scout            thr_pcw8s9ystu  thr_7aff8m3fnh  anthropic/claude-haiku-5-5  medium     2026-10-27T10:13:36.420Z  delivered  2026-10-27T10:13:35.051Z
dlg_0c5545cb-7cdc-4bbf-9940-0eafaa537c08  active  scout            thr_pcw8s9ystu  thr_qvjxq2wtxm  anthropic/claude-haiku-5-5  medium     2026-10-27T10:12:10.572Z  delivered  2026-10-27T10:12:09.232Z
```

## Writer: own managed worktree on the parent's branch
The result had `"agent":"implementer-low","workspace":"worktree","reasoningLevel":"high","permissionMode":"full"`.
- Child env `env_zcrn9cwebw`: path `…/environment-git-worktree/host-data/worktrees/thr_e4ejqc24jq-1/repo`, isWorktree true, branch `sandy/delegate-test-writer-thr_e4ejqc24jq`.
- The scout ran in the parent's checkout instead (env_zzx3vpp5pu, the same env id as the parent).
- `git reflog show sandy/delegate-test-writer-thr_e4ejqc24jq`: `b243466 …@{1}: branch: Created from sandy/delegate-test-parent-thr_pcw8s9ystu`, `5bcb87d …@{0}: commit: Add writer note`.
- The writer reported pwd = its worktree, and the commit `5bcb87d Add writer note` on its branch. The parent's checkout is unchanged at b243466.

## Archiving the writer
`sandy thread archive thr_e4ejqc24jq` set the thread's archivedAt=1793096153412. 25 s later:
- The worktree directory is still present, with README.md, config-loader.ts and writer-note.txt.
- `git worktree list` still lists it at 5bcb87d.
- The branch still exists.
- The environment env_zcrn9cwebw is `status: ready`, destroyedAt null, and canRestoreEnvironment false.
Conclusion: archiving does not remove the worktree, the branch or the commit. The ledger row stays `active`, because slice 4 does not wire lifecycle events to the ledger.

## Bind delayed 5 s (test hook `sandy delegate debug bind-delay 5000`, reset to 0 afterwards)
Child thr_vbnc3ssren of parent 2:
- Delegation row created (reserved) at 1793096085838. The child thread was created at …085842.
- The child's PI_SANDY_TOOLS_FILE (written at …085936, while the row was still reserved and unbound) already listed `sandy_delegate_brief`, so the marker came through the pluginMetadata path.
- `sandy delegate list --json` polled every ~1.3 s: `reserved childThreadId=None` at 11:14:46-11:14:50, then `active thr_vbnc3ssren` from 11:14:52.
- bound_at …090861 (5.02 s after reserve). policy issued at …090878 (the extension was polling "pending"). ack at …091203.
- The child's turn started at …091267, only after the ack (before_agent_start waits for the policy). Its first tool call was `sandy_delegate_brief`.
- After that, a nested `get_goal` was blocked: `ERR sandy-delegate: tool "get_goal" is not in this delegate's allowlist`.

## permissionMode
The `client/turn/requested` execution of child thr_vbnc3ssren was `{model: anthropic/claude-haiku-5-5, reasoningLevel: medium, permissionMode: full}`. Its parent thr_9m7s5gdm8n had `permissionMode: full`. The sandy_delegate results report `permissionMode: "full"` for each child. pi offers only `full`, so the child can only ever equal a pi parent. In the unit tests a non-pi-only mode passes through as well (`auto`).

## Not verified live
- A direct (non-codemode) call of a non-allowlisted tool. pi here runs with codemode, so every tool call the model made was nested. The direct path is covered by tests/runtime.test.mjs (real pi SDK sessions).
- Gate blocks for edit and write themselves. Live they were absent from the active tools, so codemode refused them before the gate. tests/runtime.test.mjs covers the gate block.
- provider_unsupported and isolation_unavailable. These are covered only by tests/launch.test.ts.

## Review fixes and author rerun (after Sol diff review 0b7dbcc6)
- Fix (blocker): configure gives the marker to every thread with a ledger binding (also ended) or any delegation id in metadata; such a thread gets a denied, deny-all policy unless the ledger names it a live delegation. Before, unknown/foreign/ended threads got sandy_delegate and ran ungated.
- Fix (major): the extension ignores the policy inside a "denied" answer and applies deny-all.
- Red: with both fixes reverted in a copy, protocol.test.ts + pi-extension.test.ts fail 2/12.
- Rerun live (plugin rebuilt + reinstalled, extension recopied): parent thr_ui3ryjdfs4 -> scout thr_37a6zfhzcw (dlg_87f2f7c6-…), acked 10:39:05.493Z, brief delivered, `ls` listed .git, config-loader.ts, README.md; `tools.edit does not exist`, no file changed; `sandy delegate list` shows the row.
- Observed: a call through the alias `mcp__builtin_ls__ls` was blocked (gate matches exact names since slice 1), the model retried with `ls`. Usability, not a hole; open point for later.

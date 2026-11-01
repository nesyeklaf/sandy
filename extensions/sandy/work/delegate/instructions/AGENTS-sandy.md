### In a SANDY thread

Applies only when the `sandy_delegate` tool is available (a pi session inside a SANDY thread). Elsewhere, for example the laptop TUI, the rules above stand unchanged.

- Delegate with `sandy_delegate`, not pi-subagents. `sandy_delegate_status`, `sandy_delegate_send` (steer or queue), `sandy_delegate_wait` and `sandy_delegate_stop` manage the children. Each child is a hidden SANDY child thread under yours; the owner sees and steers it from the Delegates panel.
- Agents and their models come from the catalog (`sandy work delegate agents list`): scout, researcher, oracle, evidence-auditor and reviewer for reading, auditing and review, implementer-low, implementer-medium and implementer-high for code. The catalog carries the model routing above; override `model` or `thinking` only when the routing asks for it, within the agent's allowed models.
- Readers (scout, researcher, oracle, evidence-auditor) run in your checkout and cannot change files. Writers (implementers, reviewer) get their own worktree on your branch, starting from your last commit: commit what they need first, uncommitted edits are not in it. From a thread without a git checkout (personal workspace) or for another repository, pass `project` (id or name, optionally `baseBranch`): the writer gets a worktree of that project instead.
- Writers get their own worktree, so parallel writers no longer need disjoint files. Merge a writer's branch when it is done; on a conflict abort the merge and report it.
- At most four children per root thread, workflow workers included. A fifth request gets "limit reached": wait for a child to finish or stop one.
- A child that needs a decision asks you through `sandy_ask_parent`; answer with `sandy_delegate_send`. If it waits for the owner, the question shows in the Delegates panel and the composer.

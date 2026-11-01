---
kind: instruction
title: sandy Guide — Thread lifecycle
summary: Command reference for retrying, stopping, archiving, clearing, compacting, and deleting threads.
intent: Document how agents recover and end threads.
editingNotes: Keep flags accurate against the CLI implementation. Run the json-flag-enforcement and command-output tests after changes.
---
Thread lifecycle

Lifecycle commands require an explicit thread ID or --self.

Lifecycle:

  sandy thread stop [id]                      Stop work and release the agent runtime
  sandy thread compact [id]                   Request compaction of an idle or errored thread's context
  sandy thread clear [id]                     Clear model context for an idle or failed thread
  sandy thread cancel-plan [id]               Exit the provider's active Plan mode
  sandy thread clear-goal [id]                Clear the provider's Goal
    --self                                 Target current thread

  cancel-plan and clear-goal wait for the provider to confirm.
  `thread compact` enqueues the same structured /compact turn used by the
  composer. Follow the thread timeline for the eventual compaction result.
  `thread clear` keeps the SANDY thread, workspace, durable event history, and
  sticky execution settings. Its active timeline starts at one visible
  `Context cleared` boundary, and its next prompt starts a fresh provider
  conversation in the same thread. With
  `sandy settings general keepHistoryAfterContextClear true`, earlier messages
  stay visible above that boundary. It is also the recovery for a send refused
  with `provider_session_unavailable` (`details.reason` foreign, ambiguous, or
  invalid: the recorded provider session belongs to another thread or has no
  usable identity).

  sandy thread move-directory [id] --path <dir>   Move an idle thread to another directory
    --self                                 Target current thread
    --path <dir>                           Absolute path of the target directory on the thread's host

  A thread keeps its history, project and provider conversation when it moves.
  The target must be an absolute path that exists on the host the thread runs
  on. sandy reuses the project's environment for that path, or creates an
  unmanaged one; it refuses a worktree another project owns. The loaded
  runtime is stopped first, so the next turn starts in the new directory, and
  a `Updated environment directory` event lands in the timeline. The thread
  must not be starting or active, and a path it already uses answers success
  with `changed: false`. The move stays inside the thread's project: a thread
  cannot change project, and `thread fork --environment` refuses an environment
  of another project (HTTP 409). To use another checkout of the same project,
  or to rescue a thread whose directory was deleted, move it with this command.
  An agent can do the same from inside its thread with the
  `update_environment_directory` tool; after it succeeds the agent ends its
  turn and sandy starts the next one in the new directory.
  SDK: `threads.experimental_updateEnvironmentDirectory({ threadId, path })`.

  sandy thread retry [id]                     Retry the thread's failed turn
    --self                                 Target current thread
    --turn <requestId>                     Retry this turn request id specifically; fails when it is not the thread's failed turn
    --send-at <when>                       Dispatch at an ISO 8601 timestamp or a duration from now (30s, 10m, 2h, 7d)
    --reason <text>                        Why it is being retried, shown on the queued row

  Retry re-submits the failed turn by reference: no duplicated user message in
  the timeline, and an attempt number that increments (2 is the first retry).
  What the provider is sent follows its own acceptance record — an input it
  never accepted is re-sent verbatim, while an accepted turn (already in the
  provider's conversation) is continued with a nudge rather than asked twice.
  With no --turn it retries the most recent turn, the
  one whose failure put the thread in error; --turn asserts which turn you mean
  and fails when the thread has moved on, as does retrying a thread that has not
  failed (`no_failed_turn`) or a turn that already has a retry queued
  (`retry_already_queued`). Without --send-at the retry
  is attempted now, and may still queue behind a busy thread or a plugin.
  SDK: `threads.retry({ threadId, turnRequestId?, sendAt?, reason? })`.

  sandy thread archive [id]                   Archive a thread (and children/hidden forks)
    --self                                 Archive current thread

  Archive is not a hard stop: for 30 seconds a running turn and the thread's
  terminals keep going, and unarchiving within that window leaves everything in
  place. Use `thread stop` to end a run now.

  `thread stop` preserves the thread history, metadata, environment, and future
  resume behavior. It stops active work and releases an idle agent runtime (sandy
  also releases a runtime on its own after 30 idle minutes).
  The command succeeds when no runtime is loaded. Archive a finished hidden
  worker first, then stop it to release memory promptly. A stop that only
  releases an idle runtime adds no interruption: it leaves the timeline and any
  pending interaction of that thread untouched. An explicit stop wins over work
  that is still running: when the machine still runs a turn for a thread the app
  shows as idle or failed, or a turn starts while the stop is being delivered,
  the stop interrupts that turn and waits for the attempt. If the interrupt
  fails, the thread remains stopping; check `sandy thread show <id> --json` before
  treating the stop as confirmed.

  sandy thread unarchive [id]                 Unarchive a thread
    --self                                 Unarchive current thread

  sandy thread restore-environment [id]       Restore a destroyed workspace
    --self                                 Restore current thread

  Archiving a thread retires its environment, and a managed workspace is removed
  from disk once the provider's grace window passes. Sending to a thread whose
  workspace is gone fails; `restore-environment` asks the environment provider
  to build it again and attaches it, leaving the conversation where it was.
  Each provider decides what that means: a worktree is re-created on the branch
  it held, a project checkout switches back to that branch, and a personal
  workspace cannot be restored. It starts no turn — the thread settles back to
  idle with a live workspace (check `canRestoreEnvironment` on `sandy thread show
  --json`). Unarchive the thread first; the command is refused while the thread
  is archived, while its workspace is still there, and when the provider does
  not restore, is gone, or its machine is gone. Uncommitted changes in the
  removed workspace are not recoverable.

  sandy thread delete <id>                    Delete permanently
    --yes                                  Skip confirmation

  Deleting a thread permanently deletes its sidebar children and lifecycle
  dependents recursively, including hidden and archived descendants. This also
  applies to SDK `threads.delete`; set `childThreadsConfirmed: true` to confirm
  child deletion. Provider-owned environment cleanup is asynchronous. Use
  `sandy environment show <id>` to inspect teardown until the lifecycle reaches
  destroyed. Deleting thread
  storage first stops processes whose working directory is inside it,
  including dev servers in nested checkouts (macOS and Linux only).

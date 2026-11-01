---
kind: instruction
title: sandy Guide — Environments
summary: Command reference for environment setup, inspection, commits, and merges.
intent: Provide complete environment command documentation for agents.
editingNotes: Keep flags accurate against the CLI implementation.
---
Environment commands

Environments determine where threads run. Multiple threads can share an environment
(e.g., a coding thread and a review thread in the same worktree).
The first-party choices are Project checkout (the project's existing directory),
Worktree (a fresh Git worktree), and Personal workspace (a projectless workspace).

New Worktree branches start at the selected base without an upstream, regardless
of Git's branch.autoSetupMerge setting. Publish with `git push -u origin HEAD`
to track the task's remote branch. Existing branches keep their upstream.

Making your repo work with sandy:

  If the default environment plugin is disabled or missing, creation fails
  before inserting a thread. Enable the plugin or explicitly choose another
  environment; SANDY does not silently replace an isolated worktree with a checkout.
  Host-dependent preflight checks require the selected machine to be connected.

  Commit a .sandy-env-setup.sh script at the repo root when new sandy worktrees need
  repo-specific setup. After sandy creates a new managed worktree environment, it
  looks for .sandy-env-setup.sh inside that new workspace. If the file is absent,
  provisioning continues with no error.

  The script must be tracked by git. A fresh worktree only checks out tracked
  files, so an untracked .sandy-env-setup.sh in your source checkout will not be
  present and will not run.

  SANDY runs the hook as `env bash .sandy-env-setup.sh` with cwd set to the new
  workspace. On Windows it runs the script with the bash that Git for Windows
  installs, so the same script works there; without Git for Windows the hook
  fails with a message naming it. The hook
  inherits the host daemon's sanitized environment: NODE_ENV and every SANDY_*
  variable are removed, and sandy does not inject SANDY_PROJECT_ID, SANDY_ENVIRONMENT_ID,
  or SANDY_SOURCE_PATH.

  Hooks run only in paths sandy created and owns, such as new worktrees and
  checkouts sandy cloned; attached project checkouts and personal workspaces never
  run hooks. A server restart does not interrupt a running hook, but a daemon
  restart leaves its outcome unknown.

  A non-zero exit, timeout (15 minutes), signal, or cancellation fails provisioning and sandy
  removes the new worktree after confirming the script has stopped. An unknown
  hook outcome blocks automatic cleanup and requires inspection before recovery.
  Keep optional setup steps non-fatal inside the
  script if the environment should still open. Provisioning progress reports
  "Running .sandy-env-setup.sh" and then ".sandy-env-setup.sh finished",
  ".sandy-env-setup.sh failed", or ".sandy-env-setup.sh cancelled".

  Commit a .sandy-env-teardown.sh script at the repo root when setup creates
  resources outside the managed worktree. SANDY runs the hook as
  `env bash .sandy-env-teardown.sh` from the worktree before it removes the
  worktree. The hook receives the same sanitized environment as the setup
  hook, and stdin is closed.

  Teardown has a separate 15-minute timeout. A non-zero exit, timeout, or
  signal reports failure in the destroy transcript, but sandy still removes the
  worktree once the script has stopped. An unreachable daemon leaves cleanup
  pending for retry; a hook whose outcome is unknown blocks cleanup with an
  explicit error.

  New worktrees do not contain untracked files such as .env.local. To copy
  them from the source checkout, commit a .worktreeinclude file at the repo
  root. It uses gitignore syntax: one pattern per line, # for comments, ! to
  negate an earlier pattern. sandy copies each untracked file in the source
  checkout that matches a pattern:

    .env
    .env.*
    !.env.example
    certs/

  sandy copies files only. It follows no symlinks, and it replaces nothing that
  the worktree already has. The copy runs after `git worktree add` and before
  .sandy-env-setup.sh, so the setup script can read the copied files. A pattern
  that matches nothing, or a file sandy cannot read, is reported in the
  provisioning transcript and does not fail provisioning.

  Large directories such as node_modules are copied file by file. Install
  dependencies in .sandy-env-setup.sh instead of listing them here.

  For files that customize agent instructions and skills (AGENTS.md,
  .sandy/AGENTS.md, .sandy/skills/), run `sandy guide agent-configuration`.

  sandy environment providers                List registered environment providers in picker order:
                                          Project checkout, Worktree, then other installed providers
                                          by display name; includes id, name, the `requires` facts (host,
                                          projectCheckout, gitCheckout, gitRemote, projectless), and whether
                                          it takes --environment-inputs (--json prints the JSON Schema,
                                          description, icon, and availability)
    --project <id>                        Filter by structural eligibility for this project
    --machine <id-or-name>               Scope structural eligibility to this machine
    --host <id-or-name>                  Alias for --machine

  With --project, providers whose requirements are unmet on every persistent
  machine are omitted, and `--json` reports each provider's
  `machineAvailability` per machine. Add --machine to print that machine's
  availability: `available`, `setup-required`, `unavailable` with the plugin's
  reason, or `unknown` while the background check has not answered. Listing
  never waits on a machine; results can be up to ten minutes old, and thread
  creation checks the selected provider and machine afresh.
  sandy environment list                     List environments that are not destroyed
    --project <id>                        Only environments in this project
    --provider <id>                       Only environments this environment provider produced
    --host <id-or-name>                   Only environments on this machine
    --instance-key <key>                  Only the environment its provider named with
                                          this instance key (with --provider, the one
                                          row that provider's launch produced)
    --status <status>                     Only environments in this status: provisioning,
                                          ready, error, destroyed (the only way to see
                                          destroyed rows)
    --limit <n> / --offset <n>            Page through the rows, oldest first
  sandy environment delete <id>              Request provider cleanup; refused while threads are
                                          live or stopping. The command returns with cleanup
                                          requested; lifecycle becomes destroyed only after
                                          provider removal completes
  sandy environment cleanup <id>             Remove an unused provider-managed environment now
    --recover                             After inspection, acknowledge interrupted hooks and
                                          retry failed cleanup (Linux same-user process guard)
  sandy environment show <id>                Show environment details (path, branch, status, lifecycle, retirement deadline and teardown attempts)

  sandy environment paths <id>               Search workspace paths
    --query <query>                       Fuzzy path query
    --limit <count>                       Maximum results
    --files                               Include only files unless combined with --directories
    --directories                         Include only directories unless combined with --files

  sandy environment update <id>              Update environment metadata
    --merge-base-branch <branch>          Set merge-base branch override
    --clear-merge-base-branch             Clear merge-base override
    --name <name>                         Set display name
    --clear-name                          Clear display name

  sandy environment commit <id>              Create a commit in the environment

  sandy environment archive-threads <id>     Archive all threads in an environment

  After the last live thread is archived, the environment provider's policy
  sets a retirement deadline; checkout environments never retire. A worktree
  waits five minutes and then tears down: it runs .sandy-env-teardown.sh, stops
  every process whose working directory is inside the worktree (the agent
  process, background jobs it left behind, and also shells, editors, or
  servers you started there yourself), removes the worktree, and records the
  environment as destroyed. The branch is kept. Unarchiving a thread inside
  the grace window cancels the teardown. Move your own shells out of the
  worktree first if you want to keep them. Deleting the last thread, or an
  explicit environment or project deletion, skips the grace (including a
  never-retire policy). Failed teardown retries after 1, 2, 4, and 8 minutes, then stops after
  five failed attempts with a "Needs recovery" message;
  `sandy environment show <id>` reports the lifecycle phase, deadline, teardown
  attempt, and failure message.

  `sandy environment cleanup <id> [--json]` overrides retention and retry backoff
  to remove an unused provider-managed environment early. It is not a routine
  end-of-task step. It rejects live threads and unmanaged environments,
  succeeds if already removed, and completes asynchronously. It cannot bypass
  "Needs recovery"; `sandy environment list` includes the failure message.

  `sandy environment cleanup <id> --recover [--json]` is an explicit acknowledgement
  after inspecting a failed environment. It marks interrupted hooks finished,
  resets the retry budget, and retries removal. It also handles interrupted
  setup without a recorded hook operation. A teardown hook that never started
  still runs. A daemon reboot alone never proves a detached hook has stopped.

  Recovery currently requires Linux. It refuses while a setup/hook is still
  active, while any process owned by the daemon UID has its cwd or a mapped
  file path under the workspace, or while any such process cannot be inspected.
  The guard compares paths, including deleted paths, rather than shared inode
  identity. It does not kill processes. Processes owned by other users require
  separate inspection before recovery. Stop or move your own workspace users
  first. Unsupported platforms and unavailable daemons refuse recovery.
  Existing cleanup callers can use the additive `recover` option on
  `sdk.environments.experimental_cleanup({ environmentId, recover: true })`.
  Inspect `sandy environment show <id>` after recovery to confirm removal.

  Pull requests moved to the bundled GitHub PR Status plugin:
  `sandy pull-request show|ready|draft|merge <environment-id>`. See its
  github-pr-status skill.

  Git status, branches, diffs and Viewed marks moved to the bundled Git
  plugin: `sandy git status|branches|diff|files|file|patch|viewed
  <environment-id>`. See its git skill. The old `sandy environment status`,
  `branches`, `diff`, `diff-files`, `diff-file`, `diff-patch` and
  `diff-viewed` commands still run and print the command that replaced them.

Every inspection command accepts an arbitrary environment ID and supports
`--json`.

Host commands share executable discovery across the daemon, server, desktop,
providers, and plugins. Service launches include native `~/.local/bin` installs
and mise/asdf shims. If a command disappears or exits 127, the next launch
refreshes discovery. A replaced Node executable is recovered when a compatible
runtime is available; commands with possible side effects are not retried
automatically.

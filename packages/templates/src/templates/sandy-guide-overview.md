---
kind: instruction
title: sandy Guide Overview
summary: System overview and chapter index for the sandy CLI guide.
intent: Orient agents to sandy core concepts and help them find the right guide chapter.
editingNotes: Keep this concise. Concepts only — command details belong in chapter files.
---
sandy is an agent orchestration tool for managing multiple agents.

Core concepts:

- Project — maps to a repository. All threads belong to a project.
- Thread — a single agent conversation. The fundamental unit of work.
- Environment — where a thread runs. Kinds: project checkout or isolated worktree. Multiple threads can share an environment.
- Machine — an execution host where project sources and thread environments live.
- Terminal — a persistent PTY session scoped to a thread, environment, or machine path. Use terminals for long-running commands such as dev servers.
- Provider — the agent backend powering a thread (e.g., codex, claude-code). Each provider supports different models.

Threads can have a parent-child relationship. The parent coordinates the child and receives lifecycle notifications when it completes, fails, or is interrupted. Threads without a parent are managed directly by the user.

Context variables set automatically inside a thread environment:

- SANDY_PROJECT_ID — current project
- SANDY_THREAD_ID — current thread
- SANDY_ENVIRONMENT_ID — current environment
- SANDY_CLI — absolute path to the daemon-managed `sandy` executable (prefer this if bare `sandy` is wrong; official entrypoints also re-exec to it)

Outside a thread the CLI targets http://127.0.0.1:38886; set SANDY_SERVER_URL (and
SANDY_HOST_DAEMON_PORT) only for a deliberate non-default target.

Run `sandy status` to see your current context (resolved project and thread IDs).
It also warns when an enabled plugin is not running (incompatible after a sandy
upgrade, failed to load, or missing); run `sandy plugin list` for the detail.

All commands support --json for machine-readable output. With --json a failure
prints `{"ok": false, "error": {code, message, hint}}` on stdout; `sandy guide json`
lists the output shape of each command.

Pass long or multi-line text from a file, not inline: `sandy thread tell <id>
--message-file <path>` and `sandy thread spawn --prompt-file <path>` (use `-` for
stdin). Inside double quotes the shell runs `backticks` and `$(...)` before sandy
sees the message.

Transcribe audio files, such as attached voice memos, with `sandy voice transcribe
<path>`. It uses the voice service chosen with `sandy settings ai-services`;
`sandy guide customization` lists its size limits.

When a command fails, read the whole error: sandy prints the nearest command or
option, the flag to add with the current project, thread, or machine ID filled
in, and the usage line. `sandy guide commands <group>` lists every command in a
group with its options on one page. Failures are logged without argument values
to <dataDir>/logs/cli-errors.jsonl; `sandy diagnostics cli-errors [--since 7d]
[--clear]` tallies or deletes it, and SANDY_CLI_ERROR_LOG=0 turns logging off.

To make a repo work with sandy worktrees, run `sandy guide environments` for the
repo-level `.sandy-env-setup.sh` and `.sandy-env-teardown.sh` hooks. Run `sandy guide
agent-configuration` for the data-dir and workspace files that customize agent
behavior.

Run `sandy guide <chapter>` for command details:

  threads              Spawning, handing off, forking, and editing threads
  thread-inspection    Listing, inspecting, waiting on, and opening threads
  thread-messaging     Messages, interactions, and queued messages
  thread-lifecycle     Stopping, clearing, retrying, archiving, and deleting
  environments         Environment lifecycle hooks, operations, commits, and merges
  agent-configuration  AGENTS.md and skills files that shape agents
  providers            Discovering providers and models
  projects             Project CRUD and sources
  machines             Listing and targeting execution machines, moving the
                       server
  terminals            Persistent PTY sessions across all supported scopes
  browser              Experimental built-in browser tabs and control leases
  customization        Theme, server-backed settings, keyboard shortcuts,
                       sidebar preferences, host files, voice
  plugins              Installing plugins, plugin marketplaces, bundled
                       plugins, and their contributed sandy commands
  json                 The --json contract: output shapes and the error envelope
  commands [group]     Every core command on one page; add a group for options

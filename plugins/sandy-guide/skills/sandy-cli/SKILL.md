---
name: sandy-cli
description: "Inspect or manage SANDY state with the sandy CLI; use for SANDY commands and configuration."
---

# SANDY CLI

Use sandy for SANDY state and actions. `sandy guide` is the reference manual; this skill
says where to look and how to use sandy well.

## Start with context

```sh
sandy status --json
```

- `sandy guide` prints the concepts and the chapter index. `sandy guide <chapter>`
  is the full reference for one area.
- `sandy guide commands <group>` prints every command in a group with its options.
  `sandy <command> --help` shows current flags and defaults.
- references/command-index.md lists every core command path and alias.

## Find the chapter

| Task                                                                    | Read                           |
| ----------------------------------------------------------------------- | ------------------------------ |
| Spawn, hand off, or fork threads; edit a sent message                   | `sandy guide threads`             |
| List, inspect, wait on, or open threads                                 | `sandy guide thread-inspection`   |
| Message threads, answer interactions, manage queues                     | `sandy guide thread-messaging`    |
| Stop, clear, compact, retry, archive, or delete threads                 | `sandy guide thread-lifecycle`    |
| Worktree setup hooks, environment inspection, commits, pull requests    | `sandy guide environments`        |
| Enroll, create, update, suspend, or remove machines; move the server    | `sandy guide machines`            |
| Projects, sources, attachments, project files                           | `sandy guide projects`            |
| Providers, models, service tiers, custom models                         | `sandy guide providers`           |
| Dev servers and other long-running commands                             | `sandy guide terminals`           |
| Settings, keyboard shortcuts, sidebar preferences, themes, files, voice | `sandy guide customization`       |
| `AGENTS.md` and skills                                                  | `sandy guide agent-configuration` |
| Plugins and marketplaces                                                | `sandy guide plugins`             |
| Scheduled work                                                          | the `automations` skill        |
| Built-in browser tabs                                                   | `sandy guide browser`             |
| `--json` output shapes and the error envelope                           | `sandy guide json`                |
| Writing theme CSS                                                       | references/theming.md          |

A plugin's commands and settings are documented in that plugin's own skill.
`sandy plugin list` shows which commands each plugin contributes.

## Command habits

- Resolve names and IDs with a list or show command before mutation.
- Pass the project explicitly. Pass an environment or machine selector when the
  default host is uncertain, and query provider models on the machine that will
  run the thread.
- Keep file paths on the machine that owns the selected workspace.
- Use `--json` when output controls later work. Parse stdout only: a failure
  prints the error envelope on stdout and the message on stderr, so `2>&1`
  corrupts the JSON.
- Read the whole error before running `--help`; it names the missing flag with
  the current ID filled in.
- Pass long or multi-line text with `--message-file <path>` or
  `--prompt-file <path>` (`-` reads stdin). Inside double quotes the shell runs
  backticks and `$(...)` before sandy sees the text.
- Prefer non-interactive commands. Pass `--yes` only for a destructive command
  the user confirmed.
- Inspect real status, logs, and diffs instead of assuming.
- Examples use POSIX shell syntax. In PowerShell, read an environment variable
  as `$env:NAME`, separate commands with `;`, and continue a line with a
  backtick.

## Working with threads

- Give each task one clear owner. Spawn independent tasks separately.
- Give spawned threads clear prompts: objective, constraints, expected
  deliverable, validation to perform, and what to report back.
- Let threads work. Do not poll with shell sleeps or repeated log and status
  reads; use `sandy thread wait <thread-id>` when you must block.
- `sandy thread tell` steers the active turn by default. Steer for a wrong
  direction, a hard stop, or a critical clarification; use `--mode queue` for
  non-urgent follow-ups. A send reported as `queued` is not a failure; do not
  resend it.
- For a review or fix pipeline, spawn the follow-up with
  `--environment <environment-id>` from `sandy thread show <thread-id> --json` so
  it sees the same files.
- To check whether a thread ever received a message, search
  `sandy thread log <thread-id> --all`, not the default page.
- Before retrying a failed thread, read `sandy thread show <thread-id> --json` and
  `sandy thread log <thread-id>`. Treat a thread the user stopped as intentionally
  stopped unless they ask you to continue.

## Safety

- Never move the server, abandon a move, or unlock an old copy without the
  user's explicit confirmation in this conversation. Run
  `sandy server move --to <machine> --check`, show them the checklist, and run it
  without `--check` only after they confirm. Never pass `--yes` for them.
- Only the owner can change a machine's permission limit, in the app. Read it
  with `sandy machine show <id-or-name> --json` and ask the user to change it.
- Keep secrets out of command arguments, logs, and transcripts.
  `sandy machine env set` reads its value from stdin, and enrollment bundles travel
  through a private file or environment variable. Machine and environment inputs
  are persisted and readable, so they never carry credentials. Do not print
  `serverHeaders`.
- Install a plugin by its ID. Never infer an install source
  from a display name.

## Common checks

```sh
sandy project list --json
sandy machine list --json
sandy environment providers --json
sandy provider list --environment "$SANDY_ENVIRONMENT_ID" --json
sandy thread show "$SANDY_THREAD_ID" --json
sandy thread context --self --json
sandy plugin list --json
sandy skill list --environment "$SANDY_ENVIRONMENT_ID" --json
```

## Completion

Confirm the command result and any affected thread, environment, plugin, or
remote service. Report the stable ID or URL that the user needs next.

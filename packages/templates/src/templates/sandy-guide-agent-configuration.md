---
kind: instruction
title: sandy Guide — Agent Configuration
summary: User and workspace files that customize agent instructions and skills.
intent: Document the user and workspace files that shape agent behavior for threads.
editingNotes: Keep accurate against the server's agent-instructions reader and skill loader.
---
Agent configuration

sandy reads agent configuration from the app data dir and from a project's .sandy/
directory. These files shape how agents behave in provider-backed threads.

User instructions (<dataDir>/AGENTS.md):

  Add an AGENTS.md file to the sandy data dir (usually ~/.sandy/AGENTS.md) to give
  every provider-backed thread across all projects default user-level
  instructions. sandy reads <dataDir>/AGENTS.md and appends its contents to the
  thread system prompt for all providers when a provider session starts.

Workspace instructions (.sandy/AGENTS.md):

  Add a .sandy/AGENTS.md file to a workspace to give every thread that runs there
  repo-specific instructions. sandy reads <workspace>/.sandy/AGENTS.md and appends its
  contents to the thread system prompt for all providers, after any
  <dataDir>/AGENTS.md instructions, when a provider session starts. Track it with
  git so fresh managed worktrees include it.

  Only the plural AGENTS.md is read, only from the exact data-dir and
  workspace-root .sandy/ locations above (sandy does not walk parent directories), and
  an empty file is ignored. This is sandy's own provider-agnostic instruction
  injection, separate from provider-native instruction files. Codex reads a
  repo-root AGENTS.md. Claude Code 2.1.277 and later also reads AGENTS.md when
  no project or ancestor CLAUDE.md or CLAUDE.local.md takes precedence. Older
  Claude Code versions and sessions without its built-in AGENTS.md support
  still require CLAUDE.md.

Skills (.sandy/skills/):

  A skill is a reusable instruction file that sandy injects into a thread and
  exposes to the agent as a slash command. Place project skills under
  .sandy/skills/<name>/SKILL.md in a workspace. Each SKILL.md has YAML frontmatter
  with `name` (lowercase, hyphenated, matching the directory) and `description`,
  followed by the instruction body.

  sandy resolves skills from three sources, in increasing precedence:

    plugin     Skills from enabled plugins, including the bundled SANDY guide.
    user       <dataDir>/skills (e.g. ~/.sandy/skills).
    project    <workspace>/.sandy/skills.

  A project skill overrides a user or plugin skill with the same name. Two
  skills with the same name within one source collide and are both dropped.

  User skill roots, directories, and SKILL.md entries may be symlinks. Project
  skill and command links must stay within the workspace or repository boundary.
  Supporting files inside injected skill trees must be ordinary files/directories.
  Listings collapse skills that share a name and identical SKILL.md content
  across roots; different content or a different name stays distinct. Existing IDs still address the original
  registration. Linked registrations are read-only. Codex receives a selected
  skill as a structured name/path input, including when steering an active turn.

  Use `sandy skill list` to inspect installed and discovered skills and copy the
  opaque skill ID. Each entry lists the agents that load it (`providers`) and
  its `duplicates` (same-file, same-content or same-name); `--duplicates`
  keeps only skills found more than once. `sandy skill sources <source> on|off`
  switches the sandy-owned sources sandy-plugins, sandy-user, sandy-project and shared
  (Settings → General → Skill sources); native agent roots stay as they are. `sandy skill show|files <skill-id>` reads that exact skill;
  `sandy skill show <skill-id> --json` returns the revision required by `sandy skill
  update <skill-id> --revision <sha256>`. `sandy skill delete <skill-id>` and
  update are restricted to editable, user-owned skills. These workspace-scoped
  commands default to `SANDY_PROJECT_ID`, then the personal project; pass
  `--project` or `--environment` when a different workspace is required.

  Use `sandy skill install-cli-skills` to copy sandy's built-in CLI skills into a
  machine's global agent skill roots (`~/.agents/skills` and
  `~/.claude/skills`) so agents running outside sandy can drive it. It installs on
  every connected persistent machine unless you pass `--machine <id-or-name>`
  (repeatable; required for a sandbox) (Settings → Skills has the same action). Machines install
  independently, so the command reports each machine's outcome and exits
  non-zero if any failed. The install replaces a previously installed copy of
  the same skill and leaves other skills alone. `sandy skill cli-skills-status`
  reports whether each machine is installed, out of date, missing, or unknown
  (disconnected or unreachable).

  Use the skill-creator skill to author and iterate on skills.

SANDY guide plugin:

  The enabled-by-default SANDY guide plugin owns the SANDY introduction and the
  sandy-cli, sandy-plugin-authoring, and skill-creator skills. Settings → Installed
  plugins → SANDY guide exposes introduction, a master skills switch, and one
  switch per skill. All default to true. Use:

    sandy plugin config sandy-guide set introduction false
    sandy plugin config sandy-guide set skills false
    sandy plugin config sandy-guide set sandyCli false
    sandy plugin config sandy-guide set pluginAuthoring false
    sandy plugin config sandy-guide set skillCreator false

  Changes apply when agent configuration is next assembled. They do not erase
  existing conversation text or disable independently installed copies.

## Context

- **Existing control.** `generalSettings.disabledSkillSources` (`packages/domain/src/app-settings.ts:68`) turns off whole Sandy-owned sources. It is applied when Sandy injects skills (`apps/server/src/services/skills/skill-catalog.ts:25`) and in the listing (`skill-listing.ts:366`), and it is set by `sandy skill sources <src> on|off` and General → Skill sources. Native provider roots are indexed for the listing but never filtered (`docs/configuration.md:606-610`).
- **Delivery.** At process start, `packages/agent-runtime/src/runtime-provider-process.ts:213-228` sends the bridge request `skills/configure {roots}`.
  - Pi turns the roots into `--skill <path>` (`plugins/provider-pi/src/bridge/rpc-session.ts:304`).
  - Codex sends `skills/extraRoots/set` (`plugins/provider-codex/src/bridge/bridge.ts:2555`).
  - Claude Code wraps the roots in the local plugin `sandy-global-skills` and already passes a Sandy-only SDK `settings` flag layer (`sdk-session.ts:201,217`), with `settingSources ["user","project","local"]` (`sdk-session.ts:265`).
- **Restart.** "Restart" in Sandy means `sdk.threads.stop`: it releases the loaded runtime, and the next message starts a fresh process (`extensions/sandy/pi-lifecycle/server.ts:66-70`, `sandy thread stop`).
- **Native per-skill controls in the installed versions.** The real tests of tasks 1.1-1.3 exercise the main-session control of each against the installed binary without a model turn (Codex `-c skills.config` → `skills/list enabled:false`; Pi SDK `skillsOverride` → `get_commands`; Claude `settings.skillOverrides` → `supportedCommands()`). No test observes subagents.
  - Pi 1.5.1: `--no-skills` turns off discovery, and explicit `--skill` paths still load. Settings `skills` only adds paths. The documented RPC command `get_commands` lists skills with `sourceInfo.path`.
  - Claude Agent SDK 0.3.245 (`sdk.d.ts`):
    - `Settings.skillOverrides {name: "on"|"name-only"|"user-invocable-only"|"off"}`; `off` hides a skill from the model and from `/`.
    - `Options.skills` applies to the main session only; the SDK turns it into the allow rule `Skill(x)` and it does not filter the listing, so this change does not use it (decision 6).
    - `AgentDefinition.skills` preloads skills for subagents.
    - `Query.supportedCommands()` and `initializationResult()` return the slash-command list.
  - Codex 0.166.0 app-server schema (generated from the installed binary):
    - `skills/list` returns `enabled` per skill.
    - `skills/config/write` persists to the user's config, so this change must not use it.
    - `ThreadStartParams.config` accepts overrides, and app-server launch already uses `-c key=value`.
    - A `skills.config` entry with path and `enabled = false`, passed with `-c`, turns that skill off in `skills/list` for the launched process (task 1.1).

## Goals / Non-Goals

**Goals:**
- Turn one skill, many skills or all skills off, or enable only listed skills, for every Pi, Codex and Claude Code session that Sandy starts or restores.
- Store the selection only in Sandy and write no provider or skill files, so launches outside Sandy stay unchanged.
- Keep today's behavior by default, including the existing source filtering.
- Enforce the selection at the provider's real loading point, prove each provider against its real entry point, and report a provider honestly as "not enforced" until it is proven.
- Use one mutation for UI, CLI and SDK. Say when a change applies, and reuse the existing restart.

**Non-Goals:**
- Uninstalling skills, or editing `~/.codex/config.toml`, `~/.claude/settings.json`, `~/.pi/agent/settings.json` or any `SKILL.md`.
- A security boundary.
- Providers other than Pi, Codex and Claude Code. They receive the selection in `skills/configure`, declare `not-enforced`, and load every injected skill their sources enable.
- Processes that a Pi extension spawns outside Sandy's launch.
- Restarting threads automatically.

## Decisions

1. **Where the policy lives: a server-owned setting next to `disabledSkillSources`.**
   - Alternative A, a Sandy plugin only: a plugin cannot change the provider plugins' launch arguments. It could hide rows (the agent still loads the skill) or write provider config (breaks launches outside Sandy). Rejected.
   - Alternative B, Sandy-owned provider homes (own `CODEX_HOME`, `PI_CODING_AGENT_DIR`, `CLAUDE_CONFIG_DIR` with filtered skill folders): untested; it would fork login, sessions, settings and plugins, so restored sessions and non-skill configuration drift, and whether it reaches every skill source is unproven. Rejected; the owner chose no config-home fallback.
   - Recommended: the server holds the policy and sends it with the unfiltered injected roots. Each bridge maps the policy to its provider's per-launch control for native and injected skills alike, so the catalog does not depend on the policy.
2. **Policy shape: a discriminated union, `inherit | disable(names) | allow-only(names)`.** Separate disable and allow lists that could both be set would make the result depend on precedence rules nobody can see. The union makes the two lists mutually exclusive by construction. Unknown keys and modes are rejected at the route.
3. **Composition:**
   - A skill is enabled when its Sandy-owned source is enabled and the policy enables its name.
   - Native skills have no Sandy source, so only the policy applies to them.
   - Under `inherit`, the result is exactly today's: source filtering applies, and nothing else is filtered.
   - Under `allow-only`, a newly discovered name stays off. Under `disable`, it is on.
4. **Identity: the skill name, not the origin.** Claude Code `skillOverrides`, Codex config and Pi SDK filtering all resolve the policy by name. Keying on the name gives the same meaning for every provider. The listing keeps one row per distinct content; each row names its other origins (provider, scope, path, registration id, relation: same-file, same-content or same-name), and every row of a name shows the same state, so the owner can see what a toggle covers. Claude plugin skills use the name the listing already shows for them.
5. **Delivery: extend `skills/configure` with `selection`, and bump `HOST_DAEMON_PROTOCOL_VERSION` (265 → 266).** This reuses the request every new and restored session already receives, instead of adding a second channel. A selection change never replaces a runtime: new sessions in it start with the new selection, loaded threads keep theirs until stopped or their idle session is retired, for native and injected skills alike. The server does not filter the injected catalog by the selection, so a policy-only change leaves the catalog hash unchanged and the catalog-change path, which replaces idle runtimes, runs only for source or file changes. Known limitation for the owner: loaded idle threads are not in `pendingThreadIds`, because the server has no per-thread loaded state; listing them needs a new daemon report, which is out of scope until the owner decides.
6. **Per-provider mapping:**
   - Pi: the installed-SDK worker applies the shared name predicate through `ResourceLoader.skillsOverride`, after native/package/project loading and extension discovery. It retains native RPC and the same-version native project-trust resolver. The compatibility adapter supports Pi 1.5.1; incompatible filtered starts refuse startup rather than pre-scan or auto-trust. Older supported `inherit` starts retain the native launcher. See the selected design and [worker verification](verification-pi-sdk-a.md).
   - Claude Code: only `settings.skillOverrides` set to `off` in the existing flag settings layer (`disable`: the listed names; `allow-only`: every scanned native name not listed). Overrides do not hide plugin skills, so the bridge drops disabled names from the Sandy plugin it injects. `Options.skills` is not used: the SDK turns it into the allow rule `Skill(x)` and it does not filter the listing. `settingSources` unchanged. Gaps: skills bundled with Claude Code and skills from Claude Code's own marketplace plugins; subagents unproven.
   - Codex: `-c skills.config=[...]` on app-server launch (`disable`: per name, keeping the user's own `enabled = false` entries; `allow-only`: per path from Codex's launch-time `skills/list` that the list leaves out); the app-server process key includes the selection. If `skills/list` fails under either mode, the session does not start, because the override would otherwise replace the user's own entries. Gap: under `allow-only`, skills added after launch.
7. **Enforcement status:** each bridge declares `experimental_skillSelection: {session, subagents, gaps}` with `enforced | unverified | not-enforced | not-applicable` per side. A bridge declares `enforced` only in the commit that adds its passing real-entry test; today all three declare `unverified` sessions. The Skills page and `sandy skill selection` show status and gaps. The feature is complete only when all three providers are enforced, or the owner accepts a named gap.
8. **Surfaces:** `GET`/`PUT /settings/skill-selection`, SDK `skills.experimental_getSelection`/`experimental_setSelection`, CLI `sandy skill selection [inherit|disable|allow-only|on|off] [names...]`, all computing name toggles with `setSkillNamesEnabled`. The Skills page has a name-level switch per row and on the skill page, a Skill selection menu (all off, only the shown skills on, shown skills off, every skill on), an Off mark on every row of a disabled name, and a standing note on timing and the read boundary.
9. **Apply on restart:** the mutation result lists `pendingThreadIds` (threads with running work). The CLI prints them with `sandy thread stop`; the Skills page toast offers Stop through `sdk.threads.stop`. Nothing is restarted automatically.

## Risks / Trade-offs

- [Private installed-Pi bootstrap compatibility] → The owner chose design A, including its version-bound native adapter. The two extension exclusions and dynamic trust checks pass through the real worker; other SDK versions deliberately refuse filtered startup. Full-thread and subagent acceptance remain open.
- [Claude bundled and marketplace plugin skills are not reachable by overrides] → Declared gaps. `disableBundledSkills` would reach only the bundled skills, not marketplace plugin skills, and would also remove bundled workflows. A tradeoff for the owner, not a recommendation.
- [Claude `skillOverrides` may not reach subagents] → Subagents stay `unverified`; no test observes them.
- [A name-level toggle turns off every copy of a duplicated name] → The listing shows every origin, and the switch label names the other copies. A per-copy toggle is an open question.
- [Codex app-server pooling: one process serves several sessions] → The process is keyed on the selection, so new sessions get a fresh process and running ones keep theirs.
- [Not a security boundary] → Stated on the Skills page, in `docs/configuration.md` and in the agent configuration guide.

## Migration Plan

There is no selection-data migration: a missing `skillSelection` reads as `{mode: "inherit"}`. The protocol bump makes enrolled daemons update. Rollback: set `inherit`, or revert. Selection is not persisted into provider files. The Pi worker still runs the installed Pi version's native startup migrations, which may update its legacy configuration layout just as native Pi does; all verification uses disposable fixture homes.

## Open Questions

The owner authorized the defaults: one server-wide selection, no per-project or per-provider overrides, no Codex config-home fallback, name-level only.
- **Pi:** design A is chosen and its installed-worker checks pass. Full source-app thread acceptance, subagents and SDK versions beyond the tested adapter remain unverified.
- **Claude Code and Codex:** **Owner: später**. Their named gaps are not accepted; enforcement remains open and `unverified`. No further live proof run or provider behavior change is authorized by that deferral.

## Pi SDK bridge: selected design A

**Owner chose A, including the private-import/version-gate tradeoff.** The owner chose SDK loading through `DefaultResourceLoader.skillsOverride` to close both the `resources_discover` gap and the separate pre-scan's `project_trust` mismatch. Neither gap is accepted. Claude Code and Codex remain open and `unverified`: **Owner: später**. Choosing a Pi design does not close task 6.1.

### Grounding and constraints

The existing provider bridge owns several thread sessions; each `PiRpcSession` owns an isolated Pi child with its thread's cwd and sanitized environment. It also owns input consumption, retry/compaction settlement, extension UI forwarding, recording and graceful shutdown. See [bridge construction](../../../plugins/provider-pi/src/bridge/bridge.ts), [session control](../../../plugins/provider-pi/src/bridge/rpc-session.ts) and [portable child launch](../../../plugins/provider-pi/src/bridge/rpc-child.ts). The earlier CLI mapping kept that native lifecycle but resolved the skill list before launch, causing the two known gaps; it must not survive as a fallback for filtered sessions.

Static inspection of installed Pi 1.5.1 and its SDK examples establishes:

- `createAgentSessionServices` accepts `resourceLoaderOptions.skillsOverride`. `DefaultResourceLoader.extendResources` updates the skills through that override again after `resources_discover`; `AgentSession.bindExtensions` rebuilds the effective prompt after discovery. This is the native filter point, not prompt rewriting.
- `createAgentSessionRuntime`, `createAgentSessionFromServices` and `runRpcMode(AgentSessionRuntime)` are public root exports. The runtime factory is reused on new/resume/fork/import, including a new cwd; one startup-only override is insufficient.
- SDK service creation alone does **not** reproduce CLI project trust. Pi's CLI supplies a pre-trust reload callback and runs extension `project_trust` handlers before saved/default decisions. The native `resolveProjectTrusted` and RPC startup trust-context helper exist in the installed package but are **not** public root exports. `main(args, {extensionFactories})` has no loader override hook, so merely calling public `main` cannot implement this change.
- SDK sessions do not automatically install the CLI's codemode, tool-search and MCP built-ins. Both designs must reproduce the non-skill RPC startup behavior, rather than treating a bare `createAgentSession()` as a compatible replacement.
- The repository currently tests/types against Pi 0.84.0 and advertises that minimum; installed Pi is 1.5.1. Neither design may silently bundle the older SDK, assume all versions expose this runtime shape, or install/update Pi. An installed-SDK compatibility boundary is required.

The grounding above is source/declaration evidence; runtime results are recorded separately in [worker verification](verification-pi-sdk-a.md). The two alternatives below record the design choice, not an independent design arena.

### Common loading contract

Sandy remains the sole policy owner. The host sends the existing validated selection and source-enabled injected roots; the worker never reads a Sandy setting from the user's Pi home. It receives a validated, copied selection snapshot once, and uses the existing name predicate. The loader resolves native/package/project/extension resources normally, then filters by name while preserving diagnostics and source metadata.

The sketches use the **installed 1.5.1 SDK types**, not an assertion that the repository's older devDependency already supports them. These are design sketches, not new Plugin SDK API. The implementation uses a private `{version, packageDir, args, selection}` bootstrap and Pi\'s native argument parser for existing RPC flags; the installed SDK is loaded dynamically rather than bundled from the older devDependency.

```ts
import {
  DefaultResourceLoader,
  type AgentSessionRuntime,
  type AgentSessionEvent,
  type ThinkingLevelSelectEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  ExperimentalSkillSelection as SkillSelection,
} from "@sandy-sdk/plugin-sdk/provider-bridge";

type SkillsOverride = NonNullable<
  ConstructorParameters<typeof DefaultResourceLoader>[0]["skillsOverride"]
>;

type PiSessionTarget =
  | { readonly kind: "ephemeral" }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly directory: string;
    };

type PiSdkLaunch = Readonly<{
  version: 1;
  cwd: string;
  agentDir: string;
  selection: SkillSelection;
  injectedSkillPaths: readonly string[];
  session: PiSessionTarget;
  model: { provider: string; id: string } | null;
  thinkingLevel: ThinkingLevelSelectEvent["level"] | null;
  sandyExtensionPath: string;
  systemPrompt: string | null;
  appendSystemPrompt: readonly string[];
}>;

declare function createSkillOverride(selection: SkillSelection): SkillsOverride;
declare function createSelectedRuntime(
  launch: PiSdkLaunch,
): Promise<AgentSessionRuntime>;
```

`PiSdkLaunch` is a private child bootstrap, not a server/daemon message. Its schema validates the boundary, fills meaningful defaults once and freezes the copied policy. Credentials remain in the existing child environment/normal Pi credential path, not in the bootstrap. The normal injected roots are passed through `additionalSkillPaths`; `noSkills` and per-kept-file CLI flags are removed from the selected launch path. `inherit` leaves the loader's skill result unchanged.

On every runtime creation, the factory resolves the effective cwd/session manager, establishes the actual Pi trust decision, constructs services with the same override, then constructs the session. Resource reloads keep that snapshot. A new Sandy selection only affects subsequently loaded sessions; already loaded threads, including idle threads, keep theirs until stopped or retired. A child restart for that same loaded session retains its captured selection. No process-global cwd/env mutation in the multi-thread provider bridge is allowed.

### Design A — SDK worker with native Pi RPC (recommended)

**Caller usage:** `PiRpcSession` starts a Sandy-owned SDK worker instead of the Pi CLI executable. Inside that worker, `await runRpcMode(await createSelectedRuntime(launch))` exposes Pi's native RPC implementation. Existing session callers continue using the same prompt/steer/state/commands/stop methods.

**Boundary and modules:** keep `bridge.ts → PiRpcSession → PiRpcChild`. Add a worker bootstrap and a small installed-SDK compatibility module under `plugins/provider-pi/src/bridge/`; package the worker through the existing provider artifact path. The worker imports the installed Pi package selected by the same launch resolution as the current provider, not the repository devDependency. Keep fd 3/4 and the Sandy extension's tool/settlement channel unchanged. Pass bootstrap data in a separate short-lived scratch file, not over that channel; remove it on success/failure/exit. Preserve portable Node/Bun/Windows launch resolution and recording.

**Trust ownership:** use Pi's own pre-trust reload sequence and the same-version native `dist/core/project-trust.js` resolver plus `dist/cli/project-trust.js` RPC context helper behind one compatibility module. This is a deliberate private-import tradeoff, **not** a public-SDK guarantee. Validate the installed version and required exports; support starts with the observed 1.5.1 adapter. Unknown/incompatible versions refuse filtered startup with an actionable error, never fall back to the CLI pre-scan or auto-trust. An `inherit` launch on older supported Pi keeps the existing unfiltered native CLI path; only the SDK path enforces selections. The native CLI is not a second filtering implementation.

**Lifecycle:** the worker recreates the loader through `CreateAgentSessionRuntimeFactory` for every session replacement, preserving the policy snapshot and Pi's process-local trust cache. Pi's RPC runner owns extension bindings, discovery completion before command handling, native UI request framing, session replacement and shutdown/disposal, including credential-write completion. Sandy's existing wrapper continues owning delivered-run settlement and child failure handling. A worker construction error terminates and cleans up just that thread child.

**CLI impact:** ordinary `pi` starts never execute the worker and never see its bootstrap. No installed wrapper, trust default or skill file is rewritten to apply selection, and Sandy does not substitute a provider home. The worker retains native Pi startup migrations, not a separate Sandy configuration rewrite. SDK-supported `inherit` must match the old RPC behavior for skills **and** built-in tools/extensions, prompt inputs, session persistence and model settings; the older unfiltered path remains unchanged. The version restriction applies to filtered Sandy starts, not to ordinary CLI usage.

**Protocol impact:** no new or reinterpreted server/daemon field. `skills/configure {roots, selection}` and its apply-on-next-load meaning stay as already present in this change at protocol 266. The bootstrap is provider-local. Keep `HOST_DAEMON_PROTOCOL_VERSION = 266` only after testing the existing serialized runtime-context and bridge requests unchanged against this adapter; if implementation needs any wire-field/default/meaning change, stop and bump the version.

**Tradeoff:** retain native transport/lifecycle behavior and minimize the rewrite, in exchange for a narrowly version-gated private Pi trust adapter and a small compatibility surface to maintain across Pi releases.

### Design B — direct SDK session adapter with typed worker IPC

**Caller usage:** replace `PiRpcSession` with `PiSdkSession` exposing the existing Sandy-facing session operations. It sends typed operations to one isolated SDK worker per loaded thread; there is no Pi RPC protocol or `runRpcMode` between the bridge and worker.

```ts
import type { PiRpcSession } from "../../../plugins/provider-pi/src/bridge/rpc-session.js";

type PiSdkInput =
  | { kind: "prompt"; text: string }
  | { kind: "steer"; text: string }
  | { kind: "abort" }
  | { kind: "commands" }
  | { kind: "switch"; sessionPath: string }
  | { kind: "close" };

type PiSdkOutput =
  | { kind: "event"; event: AgentSessionEvent }
  | { kind: "ready" }
  | { kind: "failure"; message: string };

type PiSdkSession = Pick<
  PiRpcSession,
  "start" | "prompt" | "steer" | "getState" | "compact" | "closeGracefully" | "kill"
>;

declare function startPiSdkSession(launch: PiSdkLaunch): Promise<PiSdkSession>;
```

This is the dominant-operation sketch, not a complete replacement protocol. The implementation must cover every operation currently used by `PiRpcSession`, including images, queued-input consumption, model/thinking changes, compaction, fork/navigation and extension UI. Request ids/replies and validation stay private to the worker transport; native SDK event objects do not leak into the public Plugin SDK.

**Boundary and modules:** `bridge.ts → PiSdkSession → isolated SDK worker`; replace the RPC child/parser with a private framed IPC transport. Keep a process per loaded thread, not SDK sessions inside the shared bridge: extension code reads process globals and must retain per-thread cwd/env isolation. The adapter directly binds the SDK runtime and translates its events and UI/tool callbacks into Sandy behavior. It removes RPC encoding and eventual duplicate RPC settlement observations, but makes Sandy own the replacement.

**Trust ownership:** this candidate uses public SDK loading/types and a Sandy-owned RPC-mode trust coordinator over the pre-trust extension handlers, `ProjectTrustStore` and defaults. It must match Pi's handler ordering, undecided/error handling, saved decisions and noninteractive ask behavior against native Pi fixtures. That is duplicated provider-integration policy and a larger conformance burden, not an existing public Pi trust helper. No private SDK monkeypatching or global auto-trust.

**Lifecycle:** Sandy owns extension bindings, startup/discovery readiness, subscriptions/rebinding after replacement, UI callbacks, input consumption, recovery/settlement, signal handling and orderly credential-safe runtime disposal. The policy is attached to every loader/runtime replacement as in A. Only emit ready after bindings and discovery finish. Worker failure rejects every pending operation and tears down that worker without changing other threads.

**CLI impact:** ordinary Pi CLI starts and their files remain untouched, as in A. For Sandy's `inherit`, this design has a larger compatibility burden because both CLI bootstrap and RPC adapter behavior are replaced. Older SDK compatibility must be explicit; unsupported filtered starts fail closed, with no CLI selection fallback.

**Protocol impact:** the same existing server/daemon fields and semantics suffice; a new provider-private IPC is not the host-daemon protocol. The same compatibility proof and conditional bump rule as A apply. No new public SDK/CLI surface is needed just to change this internal provider transport.

**Tradeoff:** avoid the private native trust import and control the SDK integration directly, in exchange for owning a new IPC/session/UI/recovery adapter and tracking native Pi trust behavior ourselves. There is no measured performance advantage claimed.

### Selected design and deciding checks

The owner selected **A**: correct the loading point while retaining the native RPC lifecycle, accepting the private-import/version restriction. B remains the unselected public-only alternative. Implementation and review evidence belong in [worker verification](verification-pi-sdk-a.md), not in these sketches.

The deciding checks use installed Pi and temporary fixture homes, **without a model turn**:

- Convert both existing `resources_discover` `it.fails` cases in `skill-selection.test.ts` to ordinary passing tests with their exclusion assertions intact. Exercise the actual production worker entrypoint, not a second test-only loader.
- Compare native RPC and the worker for an extension returning `project_trust: yes` under `ask`, and `no` under `always`: allowed project skills survive and forbidden ones are filtered; denied project resources never load. Also retain saved/default/undecided trust behavior. No trust override bypass.
- Exercise reload and session replacement in another cwd, plus captured old-selection versus new-session-selection behavior. Verify disabled extension skills stay out of both the real command list and effective system prompt, while enabled skill metadata remains intact.
- Run installed-Pi skill/package tests and targeted interruption/settlement/session tests. Compare SDK `inherit` and ordinary Pi CLI/RPC in the same fixtures for non-skill behavior. A plain native launch must still show the disabled fixture after the Sandy worker closes.
- Prove fail-closed behavior for an incompatible SDK or bootstrap, safe child cleanup, and unchanged protocol-266 runtime/bridge payloads. Do not upgrade Pi to `enforced` from source inspection alone; task 6.1 and deferred providers remain open.

All tests/builds use `VITEST_MAX_WORKERS=1` and Turbo `--concurrency=1`, one group at a time. The current thread has a roughly 1.5 GB combined RAM allowance; the orchestrator separately authorized one read-only Opus review, with no further children. No dev server/browser, install, live model turn, push, PR or deploy is authorized by this design request.

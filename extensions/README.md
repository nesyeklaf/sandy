# extensions

Sandy plugins and pi extensions that live in the repo but not in the pnpm workspace. One folder per unit, each self-contained (own `package.json`, own `node_modules`, own build). The units pin different toolchains, so the root `pnpm install`, lint, format and typecheck skip this folder. Plugins that every install ships live in `plugins/`; these are the owner's own and the pi side that needs Sandy to work.

```
sandy/sandy-sidebar-delegate  fork of bb-sidebar 0.3.7 that lists delegate children and workflows-plus workers under their parent (see UPSTREAM.md)
sandy/codex-voice    voice input through the ChatGPT login (Codex), sent with curl because chatgpt.com challenges Node's HTTP clients
sandy/genui           inline ```ui and ```app blocks in chat (fork of ComicBit/bb-plugin-genui 0.3.1)
sandy/bookmarks, compact-composer, files-editor, receipts, thread-namer, value   plugins forked from the BB ecosystem (see each UPSTREAM.md)
sandy/permissions     permission modes and command blocklist (pairs with pi/permissions)
sandy/personas        persona and skill picker in the composer
sandy/pi-lifecycle    pi process state per session; pi-extension.ts is the pi side of it
sandy/work           one SANDY plugin for work, pairs with pi/work: delegate/ (subagents as hidden child threads with enforced
                   tool allowlists), track/ (stages, gates, branches), workflows/ (workflows with reusable worker sessions,
                   fork of the BB workflows plugin, MIT), goals/ (pi goals and session tasks: composer banner and tab, read on
                   the host); server.ts runs the four through combine.ts, one database (migrations.ts), one CLI: sandy work
pi/permissions     pi extension: permission modes, blocklist
pi/fabric          pi-fabric (fork of fabric-runtime/pi-fabric; build with bun, see its AGENTS.md)
pi/work            one pi extension for work: goal/ (fork of tmonk/pi-goal-x, headless in SANDY, see goal/UPSTREAM.md),
                   track/ (blocks tools the track stage does not allow), autopilot/ (runs autopilots, drives sandy/work/track),
                   delegate/ (a delegate child's tool gate), tasks/ (every session's task list, a tasks tool),
                   gate.ts (the one tool_call gate), link.ts (thread -> pi session pointer for sandy/work/goals)
pi/context         pi extension: cache-aware context cuts, history search, notebook, keep-warm pings (signal from sandy/work/workflows)
scripts/           build.sh, install-pi.sh, install-sandy.sh
```

## Build and install

```
scripts/build.sh [unit...]    npm ci + gen + sandy plugin build, for all units or the named ones
scripts/install-pi.sh         symlink the pi extensions and autopilots into ~/.pi/agent (laptop)
scripts/install-sandy.sh [name]  sandy plugin install from this checkout (checkout must be on the SANDY server host)
```

SANDY runs its plugins from path sources on the server host (the VPS), pi runs its extensions from the laptop. Both load the code from the main checkout of this repo, so a change goes live only after it is merged into main there, built, and (for SANDY) reloaded with `sandy plugin reload <id>`.

## The SDK

Every sandy unit depends on `@sandy-sdk/plugin-sdk` as `file:../../../packages/plugin-sdk`, so it always builds against the SDK in this repo (npm links it). `sandy plugin build` works with the link. Vitest does not: the linked SDK loads its own React next to the unit's, and every component test fails with a null hook dispatcher. For tests, install a copy instead, without touching package.json:

```
(cd packages/plugin-sdk && npm pack --pack-destination /tmp)
(cd extensions/sandy/<unit> && npm install --no-save /tmp/sandy-sdk-plugin-sdk-*.tgz)
```

## Working rules

- Work happens in a git worktree per task, never in the main checkout: `git worktree add ../plugins-wt/<task> -b <task>`. Merge back into main with a fast-forward or squash merge, then pull on the VPS and rebuild.
- Two sessions never edit the same unit at the same time. If a task needs another unit's files, say so in the other session first.
- `dist/` and `node_modules/` are never committed. `sandy/pi-lifecycle/extension-source.ts` is generated (`npm run gen`); its test fails when stale.
- Tests: `npm test` in each SANDY plugin (work/workflows and genui: vitest, genui's WebCache tests need better-sqlite3's native binding, which npm's allowScripts blocks: run `npx prebuild-install` in `sandy/genui/node_modules/better-sqlite3`; personas: node --test check.test.ts), `node --test --experimental-strip-types tests/*.test.ts` in pi/permissions, `node --test --experimental-strip-types *.test.ts` in sandy/work/track and sandy/work/goals, `npm test` in pi/context, `npm test` in pi/work (after `npm ci` in pi/work/goal; the delegate runtime test loads pi's managed install, `PI_SDK_ROOT` overrides), `npm test` in sandy/work/delegate, `bun run test` and `bun run build` in pi/fabric (pi loads pi/fabric/dist).

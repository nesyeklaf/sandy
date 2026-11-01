# sandy-plugin-chief-of-staff

A chief of staff for your backlog. Paste the backlog into the **Chief of
staff** panel; the plugin opens one agent thread per item, a single "Chief of
staff" thread answers the workers' routine questions, and only the decisions
that need you show up in the panel.

## How it works

- **Workers.** Each item runs in its own thread, spawned in the project you
  pick, at most `maxConcurrent` at a time (setting, default 3). Workers get
  two tools: `cos_ask` files a question and ends the turn; `cos_report`
  records progress or marks the item done.
- **Chief.** One thread, started on the first question. The plugin hands it
  one question at a time, with your standing guidance and your recent
  decisions as precedent. It answers with `cos_answer`, hands a question to
  you with `cos_escalate` (why, options, recommendation), or closes a finished
  item with `cos_close_item`. A chief turn that ends without a decision
  escalates that question to you. The chief runs on its own provider, model
  and reasoning level (settings; default `pi`,
  `openai-codex/gpt-5.6-luna`, `medium`); workers use the project default.
- **Stalls.** A worker that stops without asking or finishing gets a check-in
  routed to the chief; after `maxNudges` check-ins (default 3) it comes to
  you. A worker blocked on an in-thread approval shows up as a decision with
  a link to the thread. Failed threads can be retried from the panel.
- **Briefing.** The panel shows counts, decisions for you, every item with its
  latest report, and an activity feed. `sandy chief-of-staff brief` prints the
  same as markdown.

Tools are only exposed to threads this plugin spawned (selected by the
thread's plugin metadata `role`).

## Layout

- `contract.ts`: RPC contract and wire types shared by server and panel.
- `core/engine.ts`: the loop (dispatch, question routing, escalation), behind
  a small `ThreadPort` so it does not depend on the SDK.
- `core/store.ts`: SQLite tables for items, questions, activity, state.
- `core/backlog.ts`, `core/prompts.ts`, `core/brief.ts`: parsing and text.
- `server.ts`: wires the engine to `sandy.sdk.threads`, events, tools, RPC, CLI.
- `app.tsx`: the panel. `skills/chief-of-staff/`: CLI skill for agents.

## Develop

```
npm install --include=dev
npm test            # vitest, uses the SDK's fake plugin host
npm run typecheck
sandy plugin install . --yes
```

If tests fail with "Could not locate the bindings file", npm blocked
better-sqlite3's install script; run `npx prebuild-install` inside
`node_modules/better-sqlite3`.

## UI components

`components/ui/` is vendored source you own (the shadcn model): edit the
files freely — they never update out from under you. Add more from the SANDY
component registry (the full shadcn set, version-matched to your SANDY install
via the pinned ref in `components.json`):

```
npx shadcn add @sandy/select @sandy/table
```

Run `npm install` once before `sandy plugin build` — the vendored components'
npm deps bundle into your dist. React, and SANDY-shimmed packages like the
radix portal primitives and `sonner` (`import { toast } from "sonner"`
reaches SANDY's own toaster), are provided by the SANDY app at runtime and never
bundled. Every shimmed package is declared in `devDependencies` at the
host's version so those imports typecheck; keep them there (never in
`dependencies`, which would bundle a second copy), and `sandy plugin types`
repins declared packages alongside the SDK; unused packages may be removed. Ship `dist/` (npm tarball or committed for
git installs) so people installing your plugin never need npm.

## Manifest

`package.json` is the plugin manifest. Notable fields:

- `sandy.server` — backend entry (required).
- `sandy.app` — frontend entry. Delete it, `app.tsx`, `components/`,
  `hooks/`, and `lib/` for a headless plugin.
- `sandy.skills` — skill roots; omitted here, so SANDY reads `skills/`. Each
  directory with a `SKILL.md` is one skill, named after the directory.
- `sandy.name` and `sandy.description` — required human-facing identity.
- `sandy.branding` — required; declare `icon` as a SANDY icon name or a
  plugin-relative compact SVG, or declare `logo.light` (with optional
  `logo.dark`). Logo assets must be relative `.svg`, `.png`, or
  `.webp` files.
- `engines.sandy` — supported sandy app version range.
- `engines.sandyPluginSdk` — the lowest plugin SDK you need (scaffold:
  `>=0.6.49`). SANDY reads this as a floor, not a ceiling: a later
  SDK in the same major still loads your plugin.
- `dependencies` — every package your source imports that SANDY does not provide.
  `sandy plugin build` inlines them into `dist/`, and git installs resolve this
  list alone, so a build-required package here rather than in
  `devDependencies` is what keeps your plugin installable. `devDependencies`
  is for types and tooling only (SANDY shims React, the portal primitives, and
  `@sandy-sdk/plugin-sdk` at runtime — never bundle them).

Run `sandy plugin build` before publishing git/npm installs. It writes
`dist/server.js` + `server.meta.json` and `app.js` / `app.css` /
`app.meta.json`. Each `*.meta.json` stamps SDK major/version,
`artifactFormatVersion`, `pluginId`, `pluginVersion`, and
`builtWith` so managed installs can verify the artifacts.

## Store listing

Two texts describe the plugin in the store. `sandy.description` in package.json
is the one-sentence hook on every browse card and the lead paragraph on the
detail page; keep it under about 140 characters. `PLUGIN_OVERVIEW.md` is the
same claim at length, shown in an Overview section under that paragraph.
Rewrite the scaffold's copy for your plugin, and update it whenever
`sandy.description` changes, so the two never disagree.

The submission to the public SANDY Community marketplace requires the file. Keep
it under 4000 characters (aim for 700 to 1800) and use headings, paragraphs,
emphasis, code, blockquotes, lists, thematic breaks, and absolute https links
only — raw HTML, images, tables, footnotes, and task lists are rejected. Do
not open with a `#` title or repeat `sandy.description` verbatim; the page
shows both directly above.

## Install

From this directory (`sandy plugin new` already ran the install; a fresh clone
needs it):

```
npm install
sandy plugin install .
```

After editing sources, reload:

```
sandy plugin reload chief-of-staff
```

Or let `sandy plugin dev` rebuild and reload on every save.

## Configure

```
sandy plugin config chief-of-staff
sandy plugin config chief-of-staff set showDone false
sandy plugin reload chief-of-staff
```

## Types & API reference

The plugin API ships as the npm package `@sandy-sdk/plugin-sdk`, pinned to an
exact version in `devDependencies` (`0.6.49` — the SDK of the SANDY
that scaffolded this plugin). After `npm install`, the full surface is on disk
at:

```
node_modules/@sandy-sdk/plugin-sdk/bundled-types/sandy-plugin-sdk.d.ts      # backend
node_modules/@sandy-sdk/plugin-sdk/bundled-types/sandy-plugin-sdk-app.d.ts  # frontend
```

Your editor and `tsc` resolve `@sandy-sdk/plugin-sdk` there through ordinary node
resolution — no path mapping. These are readable declarations: open them for an
exact signature.

The SDK surface grows with every SANDY release, so the pin has to track the SANDY you
actually run:

```
sandy plugin types          # sync this plugin's SDK surface to the running SANDY
sandy plugin types --check  # CI: fail when it does not match
```

Ask SANDY to write plugins for you: the `sandy-plugin-authoring` skill documents
the whole surface with examples.

Confused by the API, or need something the types don't explain? Clone the SANDY
repo and read the source: <https://github.com/nesyeklaf/sandy>.

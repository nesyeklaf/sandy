# Holons: shared contract v0

Part A (genui) and Part B (holon extension) are built in parallel against this file. It is the only definition of the formats; each part parses them at its boundary. A change here needs both parts updated. [fixtures/shop](fixtures/shop) is the shop from the essay in these formats, with every drift kind and the expected outputs; both parts test against it.

## Holon file: `<slug>.holon`

JSON, next to the code it describes, one holon per file. Example: [password-reset.holon](fixtures/shop/apps/account/password-reset.holon).

| Field | Rule |
|---|---|
| `format` | `"holon/v0"` |
| `id` | `[a-z0-9]+(-[a-z0-9]+)*`, unique per repository, never changed. `repo:slug` is reserved for later. |
| `kind` | Software: `context`, `system`, `container`, `component`, `operation` (the function level). `node`, `action`, `binding` and `function` are never kinds: genui reserves them for its own values and rejects loaded JSON that uses them. Work: `initiative`, `project`, `task`, `step`. Knowledge: `field`, `topic`, `concept`, `claim`, `source`. Life: `vision`, `area`, `goal`, `habit`, `data-point`. Who tree: `organisation`, `team`, `person`. |
| `partOf` | Parent slug, or `null` for a root. Several roots are allowed (the what tree and the who tree). |
| `title` | Display name; renaming changes only this. |
| `status` | `proposed`, `active`, `retired`. |
| `why`, `contract` | Strings. An empty `why` is drift, not an error. |
| `carriedBy` | Slugs of who-tree holons. |
| `code` | Paths (files or directories ending in `/`) the holon links to. Code is the atom: linked, not modelled. |
| `seams[]` | `{to, contract, readOnly?, exclusive?, proof?}`. `readOnly` (default false) draws dashed. `exclusive` (default false) means "the only writer to `to`". |
| `proofs` | Keys `I`, `It`, `We`, `They`; a missing side is open. Value `{kind, source?, every?, by?}`. Machine kinds: `ci`, `metric`, `alert`, `file`, `ticket`, `formal`. Human kinds: `interview`, `confirmation`, `ai-review`. `every` is `<n>d`; human kinds default to and max out at `90d`. |

A model is every `*.holon` under its root, except in `node_modules`, `.git` and any subdirectory that has its own `.holons/` directory: that is a separate model, like [fixtures/shop](fixtures/shop). Every field is required except those marked `?`; defaults are filled once by the parser. The card's Proof is its It side.

Errors (`sandy holon check` exits 1): invalid JSON or schema, a duplicate id, an id that differs from the file name, an unknown slug in `partOf`, `seams[].to` or `carriedBy`, a cycle in `partOf`. Warning: more than 7 children ("<id> has <n> children: a level may be missing in between").

## Contract hash

`"sha256:" + hex(sha256(utf8(contract)))` of the holon's `contract` string; for a seam, of the seam's `contract`.

## Human confirmation: `.holons/confirmations/<slug>/<yyyy-mm-dd>-<side>-<by>.json`

In Git at the repository root, one file per confirmation so two branches never conflict. Example: [2026-10-20-I-maria.json](fixtures/shop/.holons/confirmations/sign-in/2026-10-20-I-maria.json). Fields: `format` (`holon-confirmation/v0`), `holon`, `side`, `by` (who-tree slug or `agent:<name>`), `recordedBy`, `at` and `expires` (yyyy-mm-dd), `contractHash`, `answer`, `hesitation[]`, `result` (`confirmed` or `refuted`).

## Machine evidence: extension database, not Git

One record per run: `holon, side (I|It|We|They|seam:<to>), kind, source, result (pass|fail), contractHash, build (commit sha), environment, at (ISO), expires (ISO or null), detail`. Recorded with `sandy holon evidence record`; [evidence.jsonl](fixtures/shop/evidence.jsonl) is the shop's evidence in that shape. Repeatable, so it may be lost and re-run.

## Lights

Side lights: `hard` ●, `soft` ◐, `claimed` ◌, `open` ○, `refuted` ✕, `expired` ◇. From weakest: refuted, expired, open, claimed, soft, hard.

*   No proof declared: `open`.
*   Machine kind: the latest evidence for (holon, side) by `at`. None: `open`. `pass`: `hard`. `fail`: `refuted`.
*   Human kind: the latest confirmation for (holon, side). None: `open`. `refuted`: `refuted`. `confirmed`: `soft`, or `claimed` when `by` is one of the holon's carriers or is `partOf` (transitively) one of them. `ai-review` is never above `soft`.
*   Any proof is `expired` when `now >= expires`, its `contractHash` differs from the current one, or its `build` is not the current commit and either is no known commit or a path in the holon's `code` changed between it and the current commit.

A holon's light is `drift` ◇ when it has drift of its own, otherwise its weakest side (`open`, `claimed`, `soft` or `hard`). A seam's light follows the same rules from its `proof` (evidence side `seam:<to>`).

## Drift

Each drift sits at one holon: `{kind, side, seam, detail}`, with `side` and `seam` null where they do not apply.

| Kind | Rule |
|---|---|
| `break` | A side or seam is `refuted`. |
| `expired` | A side or seam is `expired`. |
| `orphan-below` | `status` is `proposed`: a Why nothing fulfils yet. |
| `orphan-above` | `why` is empty: nothing above asks for it. |
| `contradiction` | The holon has an `exclusive` seam to X, and a holon that is neither it nor its descendant has a seam to X that is not `readOnly`. Sits at the exclusive holon, `seam` = X. |

`driftBelow` counts the drift of a holon and all its descendants.

## Outputs of the CLI

All commands take `--root <dir>` (default: the repository root), `--now <iso>` and `--commit <sha>` (defaults: the clock and `git rev-parse HEAD`); the fixtures use `--now 2026-11-08T12:00:00Z --commit fixture`, and every fixture evidence has `build: "fixture"`.

*   `sandy holon check --json`: `holon-check/v0`, see [check.json](fixtures/shop/expected/check.json).
*   `sandy holon drift --json`: `holon-drift/v0`, drift sorted by holon then kind, see [drift.json](fixtures/shop/expected/drift.json).
*   `sandy holon view <slug> --json`: `holon-view/v0`, what genui draws. See [view-password-reset.json](fixtures/shop/expected/view-password-reset.json), [view-account.json](fixtures/shop/expected/view-account.json), [view-sign-in.json](fixtures/shop/expected/view-sign-in.json).

### `holon-view/v0`

`focus` is the chosen holon with role `system`: `id, kind, role, title, status, why, contract, carriedBy[{id, title}], light, drift[], driftBelow, sides{I, It, We, They}, code`. Each side: `{light, kind, source, at, expires, by, detail}`, unknown values `null`. `parent` (role `environment`, or `null` at a root): `id, kind, role, title, status, light, driftBelow`. `children` (role `part`, sorted by id): the same plus `childCount`. `seams`: every seam from or to the focus, `{from, fromTitle, to, toTitle, contract, light, readOnly, exclusive, drift}` where `drift` is a drift kind or null. `warnings`: those about the focus, its parent and its children. `computedAt`, `commit`.

Part B computes views; Part A only renders them, in chat as `Holon(Load(…))`. Tests compare every field except the text of `detail` and `warnings`.

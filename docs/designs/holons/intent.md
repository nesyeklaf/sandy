# Holons in Sandy: intent

*   **Author:** nesyeklaf
*   **Status:** Draft, nothing built
*   **Date:** 2026-11-08
*   **Background:** [Every part is a whole](https://falkeysen.com/writing/every-part-is-a-whole/)

## Why

AI writes code faster than anyone can follow. A few weeks later nobody knows what was built or what it was for. Long spec files do not fix that, because nobody reads 500 lines. We want zero hidden debt: at any moment Sandy shows where a system is not proven.

A holon is a whole and a part at once. Each holon carries a **Why** (which goal it serves), a **Contract** (what must hold) and a **Proof** (how you can see it holds). It is checked from four sides: I (can someone explain it), It (does it keep the contract), We (does the whole above count on it), They (does it hold up among everything around it). Lights per side: hard, soft, claimed, open. Drift is where the model and reality have come apart.

Two pieces of work share this intent. Each is written below as a holon itself.

## A. genui: show holons

**Why.** Agents already answer with genui components. A holon should be one of the answers they reach for, so the owner checks a card instead of reading text.

**Contract.**

1.  The gallery holds holon templates built only from existing components: `Card-holon` (Why, Contract, Proof, four sides), `Card-seam` (two neighbours and the promise between them), `Card-drift` (what broke, where, which kind). Agents find them through `ui_examples(["Card"])`.
2.  A `Holon` component draws a holon the holon extension has already computed: its card, its parent, its children and its direct seams. It never draws the whole holarchy.
3.  genui renders and computes nothing. Lights, expiry and drift are decided only by the holon extension.

**Proof.**

*   Gallery tests pass with the new templates; `check_ui` accepts each one.
*   Asked to describe an existing Sandy feature, an agent answers with a holon card without further instruction.
*   `Holon` renders a computed view of a holon with 7 children and 3 seams; the same view at 100,000 holons in the index renders as fast.

## B. holon extension: holons as Sandy artifacts

**Why.** A holon in a chat reply is gone after the thread. The model has to live next to the code, versioned with it, so a contract changes in the same pull request as the code that keeps it. Markdown documents become views of the model, not its source.

**Contract.**

1.  **One JSON file per holon in Git**, with a format version (`holon/v0`) and a JSON Schema. `partOf` is a field, not the folder: a fact lives in the model exactly once.
2.  **Desired and actual stay apart.** The holon file says where its proof comes from (a test, a metric, an alert, an interview, an expiry). Results go to an append-only evidence log. A CI run never rewrites holon files, so a holon diff is a diff of intent.
3.  **SQLite is the index, never the truth.** It is derived, gitignored, rebuilt per changed Git blob, and answers neighbourhood, drift and rollup queries. Drift sums are updated on write along the path to the root.
4.  **Only a neighbourhood is shown:** the holon, its parent, its children, its direct seams. The scale rule from the essay is also the render budget.
5.  **Every view is generated:** the map, the card, Markdown, Mermaid, C4 and Backstage exports.
6.  **Sandy surfaces.** A `fileOpener` opens `*.holon.json` as a map; a `holon` code fence renders in chat; the `sandy holon` CLI checks schema and references, lists drift by kind and prints a computed view as JSON for genui to load.

**Proof.**

*   One real Sandy feature is modelled completely: every holon with Why, Contract and Proof, all four sides rated.
*   `sandy holon check` reports each of the five drift kinds on a fixture built to contain them: orphan above, orphan below, break, expired, contradiction.
*   Two branches that change different holons merge without a conflict.
*   For 100,000 holons: cold index build under 1 s, neighbourhood query under 1 ms. A synthetic run with 137,257 holons over 7 levels measured 0.3 s parse, 0.5 s load and 4 µs per neighbourhood query (Node 26.12.1, SQLite in memory); real holons are still unmeasured.

## Out of scope

*   **Behaviour in the format.** A holon links to TLA+ specs, state machines or tests as proof; it does not contain them. Otherwise the model grows as complex as the code.
*   **Humans writing JSON.** People draw or talk, agents write the file, the picture is what gets checked. This is why JSON is acceptable here although it is rejected as an authoring format for skills.
*   **A central database as the source of truth.** It would need branching and merging for data before agents on worktrees could use it.
*   **Rendering the whole holarchy at once.**

## Open questions

*   Names of the zoom levels, and how much depth is fixed.
*   Stable IDs across renames: an immutable slug, an opaque ID, or aliases.
*   How the I side is proven: which questions, which expiry, and the agent that asks them.
*   How soft proofs are weighted so soft does not become the permanent state.
*   Holons across several repositories: one file next to the code in each repo, with references across repos and one shared index.
*   Where the evidence log lives: in Git, in Sandy's database, or both.

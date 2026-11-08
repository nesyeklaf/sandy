# Holons in Sandy: intent

*   **Author:** nesyeklaf
*   **Status:** Decided, nothing built
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
2.  A `Holon` component draws a computed view (`holon-view/v0`, see [contract.md](contract.md)) from the holon extension: the card, the parent, the children and the direct seams. It never draws the whole holarchy.
3.  genui renders and computes nothing. Lights, expiry and drift are decided only by the holon extension.

**Proof.**

*   Gallery tests pass with the new templates; `check_ui` accepts each one.
*   Asked to describe an existing Sandy feature, an agent answers with a holon card without further instruction.
*   `Holon` renders a computed view of a holon with 7 children and 3 seams; the same view at 100,000 holons in the index renders as fast.

## B. holon extension: holons as Sandy artifacts

**Why.** A holon in a chat reply is gone after the thread. The model has to live next to the code, versioned with it, so a contract changes in the same pull request as the code that keeps it. Markdown documents become views of the model, not its source.

**Contract.**

1.  **One file per holon in Git, next to the code it describes**: `<slug>.holon`, JSON content, format version `holon/v0`, a JSON Schema. The id is a readable slug without a path, unique per repository and never changed; renaming changes the title, moving changes `partOf`. `partOf` is a field, not the folder: a fact lives in the model exactly once.
2.  **Desired and actual stay apart.** The holon file says where its proof comes from (a test, a metric, an alert, an interview, an expiry). Results never go into the holon file, so a holon diff is a diff of intent. Each kind of evidence has exactly one home: machine evidence (CI, metrics, alerts) is repeatable and belongs to one build, so it lives in the extension's database; human confirmations (I, We) are not repeatable, so each is one file in Git with who and when. Every proof records what it checked, the contract hash, the build, the environment and when it expires; a changed contract voids it at once.
3.  **SQLite is the index, never the truth.** It is derived, gitignored, rebuilt per changed Git blob, and answers neighbourhood, drift and rollup queries. Drift sums are updated on write along the path to the root.
4.  **Only a neighbourhood is shown:** the holon, its parent, its children, its direct seams. The scale rule from the essay is also the render budget.
5.  **Every view is generated:** the map, the card, Markdown, Mermaid, C4 and Backstage exports.
6.  **Lights follow the essay.** Only ● counts as proven; a holon is as proven as its weakest side. Soft proofs carry no weight and expire after 90 days into drift (expired). The I side is proven by an agent that questions a person with the card's fixed questions and records the answer as ◐ for 90 days.
7.  **Levels.** The role (environment, system, part, building block, atom) is computed from the view and never stored. The kind comes from a fixed vocabulary per domain (software: context, system, container, component, function; work, knowledge, life as in the essay). Depth is free; more than 7 children is a warning that a level is missing. For software the model goes down to functions, and code is the atom it links to.
8.  **Sandy surfaces.** A `fileOpener` opens `*.holon` as a map; in chat a holon is genui's `Holon` card over a view the CLI computed, so there is one chat renderer; the `sandy holon` CLI checks schema and references, lists drift by kind, records evidence and prints a computed view as JSON for genui to load.
9.  **Several repositories later, one now.** v0 reads one repository. References across repositories are reserved as `repo:slug`; levels above several repositories will live in a model repository, with one index over all.

**Proof.**

*   The holons work models itself first, in the same repository: Part A and Part B with every holon down to function level, each with Why, Contract and Proof and all four sides rated.
*   `sandy holon check` reports each of the five drift kinds on a fixture built to contain them: orphan above, orphan below, break, expired, contradiction.
*   Two branches that change different holons merge without a conflict.
*   For 100,000 holons: cold index build under 1 s, neighbourhood query under 1 ms. A synthetic run with 137,257 holons over 7 levels measured 0.3 s parse, 0.5 s load and 4 µs per neighbourhood query (Node 26.12.1, SQLite in memory); real holons are still unmeasured.

## Out of scope

*   **Behaviour in the format.** A holon links to TLA+ specs, state machines or tests as proof; it does not contain them. Otherwise the model grows as complex as the code.
*   **Humans writing JSON.** People draw or talk, agents write the file, the picture is what gets checked. This is why JSON is acceptable here although it is rejected as an authoring format for skills.
*   **A central database as the source of truth.** It would need branching and merging for data before agents on worktrees could use it.
*   **Rendering the whole holarchy at once.**

## Risks

*   **The model grows as complex as the code.** Function-level holons were chosen against the essay's warning about model-driven architecture. Countermeasures: a function becomes a holon only when it carries a contract at a seam, agents generate and update function holons from the code, and the 7-children warning flags levels that grow too wide.

## Open questions

*   The questions the I-side agent asks beyond the four fixed ones, and how hesitation is recorded.
*   How the index works across several repositories.

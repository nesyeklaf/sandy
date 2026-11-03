# skill-usecases

Menu "Skills by use case" in the sidebar. It lists the skills of a project grouped by area, with an overview of the areas on the right.

- Source chips filter by where a skill is loaded from (agents, codex, claude, hermes, opencode, sandy, plugins, …). None selected means all. A skill that exists in several sources shows all of them.
- The overview on the right jumps to an area; on narrow screens a "Jump to…" select does the same.
- Drag a skill onto an area or onto its overview entry, or use its "Move to…" select. A moved skill is pinned; "pinned ✕" returns it to automatic placement.
- "Add area" creates an area; the header name is editable, 🗑 deletes it (skills fall back to automatic placement), ⚙ edits its keywords.
- Automatic placement scores keywords against the skill name (weight 3) and description (weight 1). No hit means "Other".
- Areas and pins live in the plugin's own storage, keyed by skill name; skill files are never changed. "Reset" restores the default areas.

`npm test` runs the tests, `sandy plugin build .` builds the bundle.

## Using skills

- **Use / Copy** on a skill row opens the composer with `/skill-name ` (the slash syntax depends on the provider).
- **Sort with AI** asks a hidden helper thread (default provider, costs tokens) to propose areas; you pick which suggestions to apply, new areas included.

## Flows

The sidebar lists Areas and Flows. A flow belongs to a use case and is a graph of blocks joined by wires: Input (values the run starts with), Skill (an installed skill or an ad hoc instruction, with a snapshot of its inputs and outputs), Gate (a question with one exit per answer), Fork (picks a path by a choice value of an Input) and Output (the file the flow delivers). A flow saved before graphs existed is read as a chain of skill blocks and stored back as a graph.

- The editor is a canvas. Drag the background to pan, Ctrl or Cmd with the wheel zooms, Fit and Auto-layout sit at the bottom left. Drag a block to move it, drag from an exit port onto a block to wire it. Gate answers and fork paths are separate exits.
- The palette on the left lists the five block kinds and the project's skills with their IO; search it, click an entry to drop it in the middle or drag it onto the canvas.
- A `+` sits under every unwired exit, on a wire when you hover it, and as **+ Add first block** on an empty flow. It opens a picker that inserts the block already wired and binds its inputs to the nearest upstream outputs of a matching type. Entries that cannot go there are greyed out with the reason.
- The panel on the right has three tabs. **Inspector** edits the selected block or wire: skill and instruction, input bindings (only upstream outputs whose type fits), output file overrides, gate question, who decides, answers, which answers end the run and files to show, fork paths (they follow the bound choice), Input fields and Output source. **Check** lists every problem with its fixes as buttons. **Outline** lists the blocks in run order with a one-line summary.
- Delete or Backspace removes the selected block or wire, Ctrl or Cmd+Z undoes, Shift+Ctrl or Cmd+Z (or Ctrl+Y) redoes. Every change saves at once.
- While the flow is still a plain chain, **Suggest steps** and **Improve with AI** stay available above the canvas.
- Check (`check.ts`) reports what would break a run: missing or changed skills, unbound or mistyped inputs, inputs produced on only some paths, gate answers and fork paths that lead nowhere, unreachable blocks, loops without a gate, and two blocks writing the same file in sequence. Each problem carries its fixes.
- `compile.ts` turns a flow without Check errors into a track machine: one stage per skill, gate and unfolded fork, a fork right after a skill becomes that stage's branches, and an answer that finishes the flow leads to a Done stage when the same stage can also continue.
- Skill and Input fields use the IO grammar `Name: type; Other?: type` with types `text`, `url`, `file`, `file(path)` and `choice(a, b)` (`io.ts`). Installed skills declare theirs in SKILL.md metadata as `inputs` and `outputs`; the server parses them into the skill rows and reports malformed entries as `ioErrors`.
- **Run flow** is disabled while Check reports errors. It opens the composer with a prompt that tells the agent to call `flow_track` and start the returned machine with `stage_start`; the work plugin's Stages tab and approval forms show the run. The prompt also lists the steps, as a fallback when no track tools are available.
- **Create with AI**, **Suggest steps** and **Improve with AI** ask a hidden helper thread; the answer is only a proposal until accepted. Unknown skill names are dropped.
- Deleting an area moves its flows to Other.

## Running a flow from the composer

- Type `!` in any composer: a menu lists your areas, Enter (or the right arrow) opens an area, the left arrow or Backspace goes back. Typing after `!` searches flows by name across all areas. Pick a flow and keep writing. The flow becomes a pill; when you send, the agent gets the same run instructions as **Run flow** as hidden context. A step whose skill is not installed is followed from its note.
- The composer's `+` menu has a **Flows** entry that opens the same list as a popup.
- `~` lists the same flows flat through the backend mention provider (it resolves the pill at send time).
- Uses the experimental composer-menu (`experimental_menus`), mention-provider and composer-popup APIs.

## Agent tools

`skill_areas` lists skills by area, `skill_flows` lists saved flows with their steps, `flow_track` takes a flow name or id and returns the flow compiled into a track machine for `stage_start`, or its Check problems as an error. All three are added to every thread.

# skill-usecases

Menu "Skills by use case" in the sidebar. It lists the skills of a project grouped by area, with an overview of the areas on the right.

- Source chips filter by where a skill is loaded from (agents, codex, claude, hermes, opencode, sandy, plugins, …). None selected means all. A skill that exists in several sources shows all of them.
- The overview on the right jumps to an area; on narrow screens a "Jump to…" select does the same.
- Drag a skill onto an area or onto its overview entry, or use its "Move to…" select. A moved skill is pinned; "pinned ✕" returns it to automatic placement.
- "Add area" creates an area; the header name is editable, 🗑 deletes it (skills fall back to automatic placement), ⚙ edits its keywords.
- Automatic placement scores keywords against the skill name (weight 3) and description (weight 1). No hit means "Other".
- Areas and pins live in the plugin's own storage, keyed by skill name; sorting never changes skill files. "Reset" restores the default areas.

`npm test` runs the tests, `sandy plugin build .` builds the bundle.

## Using skills

- **Use / Copy** on a skill row opens the composer with `/skill-name ` (the slash syntax depends on the provider).
- **Sort with AI** asks a hidden helper thread (default provider, costs tokens) to propose areas; you pick which suggestions to apply, new areas included.

## Editing skills

**Skills** in the sidebar opens a searchable list of the project's skills; built-in and plugin skills are marked read-only. Picking one opens its SKILL.md, read and written through `sandy.sdk.skills.experimental_read` and `experimental_write`, so a symlinked skill is saved at the file the link resolves to.

- The editor covers the description (with a counter against the 200 character limit of the forge skill check), `metadata.inputs` and `metadata.outputs` as rows (name, optional, type, file path or choice values), other string metadata as key and value, and the body with a Markdown preview.
- `skill-file.ts` edits the frontmatter through the `yaml` Document API and only touches the fields you changed: key order, comments and unknown keys stay as written, and an untouched file saves byte for byte. New metadata values are written as quoted strings. IO rows are checked with `parseIo` and the PascalCase name rule.
- Save sends the revision the file had when it was opened. When the file changed in between, the editor offers **Reload** (drop your changes) or **Overwrite** (write your version over the new one). Leaving with unsaved changes asks first.
- A save publishes a change, so the flow canvas rereads the skills and Check updates. **Edit skill** next to a skill block's Inputs in the Inspector opens the editor on that skill.

## Flows

The sidebar lists Areas and Flows. A flow is a skill in the skill dialect: a SKILL.md with `metadata.dialect` whose `{% stage %}`, `{% input %}`, `{% output %}`, `{% gate %}` and `{% next %}` tags the work plugin's track runs. The canvas is one view of that file. Every project skill with `metadata.dialect` opens as a flow; a dialect skill that does not convert is listed under **Skills that do not open as flows** with its problems. A flow belongs to a use case (the skill's area) and is a graph of blocks joined by wires: Input (values the run starts with), Skill (an installed skill or an ad hoc instruction, with a snapshot of its inputs and outputs), Gate (a question with one exit per answer), Fork (picks a path by a choice value of an Input) and Output (the file the flow delivers). A flow saved before graphs existed is read as a chain of skill blocks and stored back as a graph.

- The editor is a canvas. Drag the background to pan, Ctrl or Cmd with the wheel zooms, Fit and Auto-layout sit at the bottom left. Drag a block to move it, drag from an exit port onto a block to wire it. Gate answers and fork paths are separate exits.
- The palette on the left lists the five block kinds and the project's skills with their IO; search it, click an entry to drop it in the middle or drag it onto the canvas.
- A `+` sits under every unwired exit, on a wire when you hover it, and as **+ Add first block** on an empty flow. It opens a picker that inserts the block already wired and binds its inputs to the nearest upstream outputs of a matching type. Entries that cannot go there are greyed out with the reason.
- The panel on the right has three tabs. **Inspector** edits the selected block or wire: skill and instruction, input bindings (only upstream outputs whose type fits), output file overrides, gate question, who decides, answers, which answers end the run and files to show, fork paths (they follow the bound choice), Input fields and Output source. **Check** lists every problem with its fixes as buttons. **Outline** lists the blocks in run order with a one-line summary.
- Delete or Backspace removes the selected block or wire, Ctrl or Cmd+Z undoes, Shift+Ctrl or Cmd+Z (or Ctrl+Y) redoes. Every change saves at once.
- While the flow is still a plain chain, **Suggest steps** and **Improve with AI** stay available above the canvas.
- Check (`check.ts`) reports what would break a run: missing or changed skills, unbound or mistyped inputs, inputs produced on only some paths, gate answers and fork paths that lead nowhere, unreachable blocks, loops without a gate, and two blocks writing the same file in sequence. Each problem carries its fixes.
- `skill-flow.ts` converts both ways. `flowToSkill` writes one stage per skill, gate and fork block; a fork right after a skill becomes that stage's `next` tags, a gate's answers are a `choice` output and `next` tags on `equals($gate.Answer, …)`, and an exit that finishes the flow is `next to="done"`. Two paths to the same stage merge into one `next` with `or(…)`. `skillToFlow` reads a parsed SKILL.md back into blocks and lays them out automatically. Block positions are not part of the file: they live in the plugin KV under `positions`, keyed by skill name. Moving blocks only updates that cache; any other change rewrites the SKILL.md with the revision it was read at, and a file changed outside the editor is reported as a conflict and reread.
- A skill block wired to several blocks at once is a Check error: a track runs one stage at a time.
- Flows saved before skills existed stay in the plugin KV and show **Not a skill yet**. **Save as skill** writes them as a new SKILL.md in `.sandy/skills` of the project or in `~/.agents/skills` (`sandy.sdk.skills.experimental_create`) and drops the stored copy. **New flow** creates the skill the same way.
- Skill and Input fields use the IO grammar `Name: type; Other?: type` with types `text`, `url`, `file`, `file(path)` and `choice(a, b)` (`io.ts`). Installed skills declare theirs in SKILL.md metadata as `inputs` and `outputs`; the server parses them into the skill rows and reports malformed entries as `ioErrors`.
- **Run flow** is disabled while Check reports errors. It opens the composer with a prompt that tells the agent to call `stage_start` with the flow's skill (a flow not yet saved as a skill goes through `flow_track`); the work plugin's Stages tab and approval forms show the run. The prompt also lists the steps, as a fallback when no track tools are available.
- **Create with AI**, **Suggest steps** and **Improve with AI** ask a hidden helper thread; the answer is only a proposal until accepted. Unknown skill names are dropped.
- Deleting an area moves its flows to Other.

## Running a flow from the composer

- Type `!` in any composer: a menu lists your areas, Enter (or the right arrow) opens an area, the left arrow or Backspace goes back. Typing after `!` searches flows by name across all areas. Pick a flow and keep writing. The flow becomes a pill; when you send, the agent gets the same run instructions as **Run flow** as hidden context. A step whose skill is not installed is followed from its note.
- The composer's `+` menu has a **Flows** entry that opens the same list as a popup.
- `~` lists the same flows flat through the backend mention provider (it resolves the pill at send time).
- Uses the experimental composer-menu (`experimental_menus`), mention-provider and composer-popup APIs.

## Agent tools

`skill_areas` lists skills by area, `skill_flows` lists saved flows with their steps, `flow_track` takes a flow name or id and returns the `stage_start({skill})` call that runs it; for a flow not yet saved as a skill it returns the track machine for `stage_start({machine})`. Check problems come back as an error. All three are added to every thread.

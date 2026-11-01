# Showcase inventory

One row per unit of this setup: the bb fork, its BB plugins, the pi extensions and the skills. A hero is a unit that only this setup has and that a viewer sees in 15 seconds. Everything else gets one line in the tour or nothing.

Sources: `FORK.md`, the private plugins repo README, `bb plugins list` and `~/.pi/agent/settings.json` on 2026-10-31. Feature lists stay there; this table only judges how to show them.

| Unit | What it does for you | Seen in 15 s | Only here | Runs on stock bb | Public | Live = main |
| --- | --- | --- | --- | --- | --- | --- |
| Fork: TOC rail topics slot | Topic brackets and a popover tab on the thread rail | yes | yes | no, fork slot | yes | yes |
| Fork: connection overview | `bb connections` and a page listing every host bb talks to, red when an unknown one shows up | yes | yes | no, fork builtin | yes | yes |
| Fork: local-first | bb connect, telemetry, update checks and remote plugin fetches removed; tailnet-only binds | no, an absence | yes | no | yes | yes |
| Fork: perf lab | Scripted A/B captures with bootstrap intervals, Firefox lab, field benchmark | numbers only | yes | yes | yes | yes |
| Fork: message deep links | `BbNavigate.toThread(id, { experimental_messageSeq })` | no, plumbing | yes | no | yes | yes |
| bb/work: delegate | Subagents as hidden child threads with an enforced tool allowlist | yes | yes | yes | no | no, worktree |
| bb/work: track + pi/work gate | Stages with gates; a tool the stage does not allow is blocked | yes | yes | yes | no | no, worktree |
| bb/work: workflows | Multi-agent workflow runs with reusable workers and live progress | yes | partly, fork of get-bb workflows | yes | no | no, worktree |
| bb/work: goals + pi/work tasks | Goal banner and the live task list of a pi session | yes | yes | yes | no | no, worktree |
| bb/bb-sidebar-delegate | Sidebar lists delegate children and workflow workers under their parent; topics | yes | yes | topics need the fork slot | no | yes |
| bb/genui | Agents answer with live UI: charts, forms, plans; own Evidence and Ops components | yes | partly, fork of ComicBit/bb-plugin-genui | yes | upstream yes, fork no | yes |
| bb/codex-voice | Voice input through the ChatGPT login | needs sound | yes | yes | no | yes |
| bb/permissions + pi/permissions | Permission modes and a command blocklist for pi | a blocked command, yes | yes | yes | no | yes |
| bb/pi-lifecycle | pi load state, CPU and RAM per session, restart and reload | yes, a table | yes | yes | no | yes |
| bb/personas | Persona and skill picker in the composer | yes | yes | yes | no | yes |
| bb/field-latency | Menu, dialog and scroll latency from the owner's own browser | numbers only | yes | yes | no | yes |
| bb/compact-composer | Three-line composer on phones | phone only | yes | yes | no | no, worktree |
| bb/ideas, chief-of-staff, tasks | Ideas timeline, backlog runner, task board | disabled | yes | yes | no | n/a |
| pi/context | Sessions that never end: planned cuts, notebook, history search | no, invisible | yes | n/a, pi | no | yes |
| pi/advisor, pi/fabric | Claim-vs-evidence gate; tool and agent runtime | no | partly | n/a, pi | no | yes |
| Skills (~80, `~/.agents/skills`) | step-back, be-ambitious, quick-plan and the rest of the working method | as a flow, yes | yes | n/a | no | yes |

## Heroes

Picked by "only here" and "seen in 15 s", in this order:

1. **Delegates you can watch**: bb/work delegate + bb-sidebar-delegate. A parent thread hands out work; the children appear under it in the sidebar with their status.
2. **Stages that hold the agent**: bb/work track + pi/work gate. The agent tries a tool the current stage does not allow and is stopped.
3. **Topics on the rail**: fork slot + bb-sidebar-delegate. A long thread gets brackets on its TOC rail; one click jumps to the topic.
4. **Every connection, named**: fork connection overview. The page lists each host bb reached and turns red at an unknown one.
5. **Answers you can use**: bb/genui with its own components. The agent answers with a plan to approve and a form to fill, not a wall of text.

Tour lines, no clip: local-first fork, perf lab numbers, pi/context sessions that run for days, permissions, pi-lifecycle.

## Viewers cannot install this

Only the fork is public. The plugins, pi-setup and pi extensions are private, so the showcase introduces the setup and its author (owner decision on #22); it does not offer an install path.

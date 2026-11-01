---
name: chief-of-staff
description: Check or steer the user's backlog run with the `sandy chief-of-staff` CLI. Use when the user asks for a progress briefing, what decisions wait on them, to add backlog items, to answer a pending decision, or to pause or resume dispatch.
---

# Chief of staff

The Chief of Staff plugin runs the user's backlog. Each item gets its own
worker thread. One "Chief of staff" thread answers the workers' routine
questions, and the questions only the user can decide wait in the plugin's
panel and in `sandy chief-of-staff decisions`.

## Commands

| Command | Effect |
| --- | --- |
| `sandy chief-of-staff brief` | Markdown briefing: counts, decisions waiting on the user, item states, recent activity. |
| `sandy chief-of-staff list [--json]` | Every backlog item with its id, state, and thread id. |
| `sandy chief-of-staff decisions [--json]` | Questions waiting on the user, with the chief's recommendation and options. |
| `sandy chief-of-staff add <project-id> <text>` | Add items; each line of `<text>` is one item (`\n` in an argument is a line break). |
| `sandy chief-of-staff decide <question-id> <answer>` | Send the user's decision to the worker. |
| `sandy chief-of-staff pause` / `resume` | Stop or restart starting queued items. Running items keep going. |

## Rules

- `decide` speaks for the user. Run it only with an answer the user gave you
  in this conversation, never with your own guess.
- To brief the user, run `brief` and summarize: lead with the decisions that
  wait on them, then progress.
- Project ids come from `sandy status` or `sandy project list`.

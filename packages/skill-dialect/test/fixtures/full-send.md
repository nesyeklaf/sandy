---
name: full-send
description: Build an approved plan with subagents without losing the owner's intent or understanding. Routes implement, delegate, verify, review and ship. Use once full-control recorded the go.
metadata:
  dialect: "1"
---

# Full Send

Execution router. The draft MR/PR from `full-control` is the plan, its slice packets are the briefs. You orchestrate, delegates build, every result is checked against the packet. A decision the plan did not delegate is not taken silently.

## Before you start

- Talk to the owner as in the `coffeetime` skill.
- Load `workflow` first. It owns the forge, the state table, the gates and the merge rules.
- This skill ships a track (`stages.json`). In a Sandy thread, call `stage_start({skill: "full-send"})` before step 1, then follow the stages: `stage_status` shows the current one, `stage_advance` moves on once its gate holds.

## Inputs

- `MR`: the draft MR/PR from `full-control`, with the owner's go recorded and a packet on every slice.

## Procedure

Follow [procedure](references/procedure.md) step by step.

Gates:
- Step 1: no recorded go (outside the fast lane) or slices without packets: back to `full-control`.
- Step 4: a decision that touches intent, a contract or something irreversible, or matches the packet's Stop if, waits for the owner, through `full-control`.
- Step 7: the owner gate, human Goldfish, with the owner's prediction.
- Step 8: merge only on the owner's word or a standing approval whose conditions all hold. Publishing, deleting, force pushes and external posts stay with the owner.
- Step 9: the owner picks the next issue or stops.

## Output

The MR is ready or merged per `workflow`. Every slice is checked with evidence in Verify. Reviews are clean. The owner's restatements of the built slices are compared with the Goldfish's and the Intent lines, and every divergence is sorted. The owner predicted at least one consequential behavior of the built change, or the mismatch is sorted. Every build decision is listed as intent or default. The backlog is updated and the owner picked the next issue or stopped.

{% allow subagents="scout, oracle, reviewer, writer" /%}

{% stage id="entry" title="Entry gate" %}
Read the MR with the workflow resume playbook. Continue only with a recorded go or in the fast lane of workflow section 5. Choose the shape.
{% needs "the draft MR/PR with the owner's go" /%}
{% output name="mr_url" description="the draft MR/PR" /%}
{% output name="go" description="link to the recorded go, or the fast-lane reason" /%}
{% output name="shape" description="serial slices, parallel lanes or orchestrate, and why" /%}
{% allow skills="full-send, workflow, full-control, implement-spec" edits=false subagents="scout" /%}
{% gate type="outputs" /%}
{% next to="build" /%}
{% /stage %}

{% stage id="build" title="Build slices" %}
Each slice in the implement-spec loop. Delegates per the routing table in AGENTS.md; a slice is done when its Accept ran green on the real artifact.
{% needs "entry.mr_url" /%}
{% needs "entry.shape" /%}
{% output name="slices" description="per slice: commit, Accept command and its result" /%}
{% output name="decisions" description="build decisions, each marked owner intent or builder default" optional=true /%}
{% allow edits=true subagents="implementer-low, implementer-medium, implementer-high, scout, oracle, reviewer, writer" /%}
{% gate type="outputs" /%}
{% gate type="evidence" name="accept" description="every slice's Accept command run in this visit, with its exit code" /%}
{% next to="verify" /%}
{% /stage %}

{% stage id="verify" title="Verify the whole" %}
The workflow verification playbook, review over the whole MR, then one independent review on a different model family. Fixes go back to build.
{% needs "build.slices" /%}
{% output name="tests" description="the full test command and its result" /%}
{% output name="review" description="findings and how each was resolved" /%}
{% allow edits=false subagents="reviewer, oracle, scout" /%}
{% gate type="outputs" /%}
{% gate type="evidence" name="tests" description="the full test command run in this visit and its exit code 0" /%}
{% gate type="evidence" name="reviewer" description="which agent and model reviewed, and the delegation id" /%}
{% next to="owner" label="tests are green and the review is clean" /%}
{% next to="build" label="a check or the review found real issues" /%}
{% /stage %}

{% stage id="owner" title="Owner gate" %}
The human Goldfish round of full-control/references/goldfish.md in build mode, the owner's prediction (limit-cognitive-debt step 5), and the build decisions in two columns: owner intent and builder default.
{% needs "build.decisions" /%}
{% needs "verify.review" /%}
{% output name="restatements" description="owner and Goldfish restatements, and how each divergence was sorted" /%}
{% output name="prediction" description="the owner's prediction and what the real run showed" /%}
{% allow skills="full-send, full-control, limit-cognitive-debt, workflow" edits=false subagents="oracle, scout" /%}
{% gate type="goal" label="when a goal is linked: its auditor approved it" optional=true /%}
{% gate type="outputs" /%}
{% gate type="user" prompt="Does the build match your intent, and may it ship?" /%}
{% next to="ship" /%}
{% next to="build" label="a divergence needs a code change" /%}
{% /stage %}

{% stage id="ship" title="Ship" %}
The workflow ship playbook. Mark the MR ready; merge only on the owner's word. Publishing, deleting and force pushes stay with the owner.
{% needs "entry.mr_url" /%}
{% output name="mr_state" description="ready or merged, with the link" /%}
{% allow skills="full-send, workflow, write-docs" edits=false subagents="" /%}
{% gate type="outputs" /%}
{% next to="learn" /%}
{% /stage %}

{% stage id="learn" title="Learn and pick the next" %}
What the merged MR taught. Reread the backlog issues: close what is moot, reword what changed, add what was learned. The owner picks the next issue or stops; the next MR is planned with full-control.
{% needs "ship.mr_state" /%}
{% output name="learned" description="what the build or the owner's run showed that the plan did not know" /%}
{% output name="backlog" description="issues closed, reworded or added, with links" /%}
{% output name="next" description="the issue the owner picked, or stop" /%}
{% allow skills="full-send, full-control, write-spec, coffeetime, limit-cognitive-debt" edits=false subagents="writer, scout" /%}
{% gate type="outputs" /%}
{% gate type="user" prompt="Is this what we learned, and which issue is next (or stop)?" /%}
{% /stage %}

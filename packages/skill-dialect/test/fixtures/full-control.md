---
name: full-control
description: Plan work that subagents will build, so the owner keeps the intent and understands the plan. Routes explore, design, spec and a fresh-context spec review. Use before handing slices to agents.
metadata:
  dialect: "1"
---

# Full Control

Planning router. One long session, the **Elephant**, holds the context and drafts the plan. Fresh subagents, the **Goldfish**, see only the written plan and test it. The owner states the intent, then reads the written plan cold as the **human Goldfish**: their restatement is compared with the Goldfish's, and a prediction shows they understand it. The only output is a draft MR/PR whose slices a stranger can build, with the owner's go recorded. Building is `full-send`.

## Before you start

- Talk to the owner as in the `coffeetime` skill.
- Load `workflow` first. It owns the forge, the state table, the lanes and the gates. An MR whose plan already has the owner's go belongs to `full-send`.
- This skill ships a track (`stages.json`). In a Sandy thread, call `stage_start({skill: "full-control"})` before step 1, then follow the stages: `stage_status` shows the current one, `stage_advance` moves on once its gate holds.
- No isolated subagent available for the Goldfish review: stop and say so.

## Inputs

- `Request`: what the owner wants planned.

## Procedure

Follow [procedure](references/procedure.md) step by step. Slice packets: [slice-packet](references/slice-packet.md). Goldfish rounds: [goldfish](references/goldfish.md).

Gates:
- Step 1: the owner states goal, first version and appetite in their own words.
- Step 3: the owner agrees with the chosen design.
- Step 4: where the backlog lives, when the forge does not take issues.
- Step 5: intent findings from the Goldfish go to the owner.
- Step 6: the human Goldfish round and the owner's prediction.
- Step 7: the owner's go.

## Output

A draft MR/PR whose description is the only plan. Every slice has its packet. The last Goldfish round has no open findings. The owner's restatements are compared with the Goldfish's and every divergence is sorted. The owner predicted at least one consequential behavior, or the mismatch is sorted. The go is recorded as an MR comment, with the lane and the open intent questions. Nothing short of this is done.

{% allow edits=false subagents="scout, oracle, researcher, evidence-auditor, reviewer, writer" /%}

{% stage id="intent" title="Intent" %}
Restate the owner's goal, first version, appetite, constraints and done criteria in their words.
{% needs "the owner's request" /%}
{% output name="goal" description="goal and done criteria, one paragraph, quoted from the owner" /%}
{% output name="first_version" description="the owner's one sentence: what the first version does for them" /%}
{% output name="appetite" description="how many days or weeks the owner says this is worth" /%}
{% output name="other_goals" description="goals for others (upstream, team, release) the owner named, kept apart and not planned now" optional=true /%}
{% output name="constraints" optional=true /%}
{% allow skills="full-control, explore-unknowns, limit-cognitive-debt" edits=false subagents="" /%}
{% gate type="outputs" /%}
{% gate type="user" prompt="Is this the goal, the first version and the appetite, in your words?" /%}
{% next to="explore" label="code, domain or requirements are unclear" /%}
{% next to="design" label="the shape is open but the ground is known" /%}
{% next to="spec" label="the change is small and clear" /%}
{% /stage %}

{% stage id="explore" title="Explore unknowns" %}
{% needs "intent.goal" /%}
{% output name="decision_map" description="known/unknown quadrants and the decisions they force" /%}
{% output name="observed" description="each problem in scope: observed (run, repro or log, with the link) or suspected; the owner's use case run once against the current build, or why it could not run" /%}
{% allow skills="full-control, explore-unknowns, understand, vault-recall, step-back, grand-scheme, prototype" edits=false /%}
{% gate type="outputs" /%}
{% next to="design" /%}
{% next to="spec" label="no design choice is left open" /%}
{% /stage %}

{% stage id="design" title="Design" %}
At least two competing sketches, then a choice.
{% needs "intent.goal" /%}
{% needs "explore.decision_map" /%}
{% output name="options" description="two or more sketches with tradeoffs" /%}
{% output name="choice" description="the chosen design and why" /%}
{% allow skills="full-control, architect, understand, step-back, grand-scheme" edits=false /%}
{% gate type="outputs" /%}
{% gate type="user" prompt="Do you agree with the chosen design?" /%}
{% next to="spec" /%}
{% /stage %}

{% stage id="spec" title="Spec" %}
Verifiable slices for the next MR only, in its draft MR/PR description. Later work becomes backlog issues.
{% needs "intent.goal" /%}
{% needs "design.choice" /%}
{% output name="slices" description="slices of the next MR with their checks" /%}
{% output name="size" description="slice count and three-point estimate of the next MR against intent.appetite, and what was cut" /%}
{% output name="backlog" description="later work as backlog issues (links), no branches or PRs" optional=true /%}
{% output name="mr_url" description="the draft MR/PR" optional=true /%}
{% allow skills="full-control, write-spec, write-tests, write-docs, write-clearly, coffeetime, meeting-with-engineers" edits=false /%}
{% gate type="outputs" /%}
{% gate type="evidence" name="text_check" description="write-spec scripts/check-forge-text.mjs run on every issue and PR body written in this stage, with its exit code" /%}
{% next to="review" /%}
{% /stage %}

{% stage id="review" title="Spec review" %}
A fresh-context review on a different model family.
{% needs "spec.slices" /%}
{% output name="verdict" description="findings and how each was resolved" /%}
{% allow skills="full-control" edits=false subagents="reviewer, oracle" /%}
{% gate type="outputs" /%}
{% gate type="evidence" name="reviewer" description="which agent and model reviewed, and the run id" /%}
{% next to="go" label="the spec holds" /%}
{% next to="spec" label="the review found real issues" /%}
{% /stage %}

{% stage id="go" title="Go" %}
The owner records the go; full-send takes over afterwards.
{% needs "spec.slices" /%}
{% needs "review.verdict" /%}
{% allow skills="full-control, full-send" edits=false subagents="" /%}
{% gate type="user" prompt="Go: build this plan with full-send?" /%}
{% /stage %}

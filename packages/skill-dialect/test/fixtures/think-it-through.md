---
name: think-it-through
description: "Frame a decision, weigh the options, fail the pick in a premortem and have an independent checker review it against the musts; loops back to weigh on a broken must."
metadata:
  dialect: "1"
---

# Think it through

Run the steps in order. Each step names the skill to use and what it must hand on. Where a step says "go to", follow it.

{% input name="Task" type="text" /%}
{% input name="Choice" type="text" /%}

{% stage id="frame" skill="frame-the-problem" %}
Use frame-the-problem on {% $input.Task %}. List every criterion the owner stated as a must, one per line.
{% output name="Frame" type="text" /%}
{% output name="Clear" type="choice(yes, no)" /%}
{% output name="Musts" type="list(text)" /%}
{% next to="ask" when=equals($frame.Clear, "no") label="The frame has an open point: go to ask" /%}
{% next to="weigh" label="The frame is clear: go to weigh" /%}
{% /stage %}

{% stage id="ask" gate="user" %}
Ask the owner the open point from the frame, then go to frame.
{% next to="frame" label="Answer received: go back to frame" /%}
{% /stage %}

{% stage id="weigh" skill="weigh-options" %}
Use weigh-options on {% $input.Choice %} with this frame: {% $frame.Frame %}
{% if and(present($review.Checks), any($review.Checks, "broken")) %}
The last review found broken musts:
{% $review.Checks %}
Address those first.
{% /if %}
{% output name="Pick" type="text" /%}
{% next to="premortem" label="Pick made: go to premortem" /%}
{% /stage %}

{% stage id="premortem" skill="premortem" %}
Use premortem in quick mode on the pick.
{% output name="Premortem" type="text" /%}
{% next to="review" label="Premortem written: go to review" /%}
{% /stage %}

{% stage id="review" %}
Judge the pick against each must, one line per must: met, broken or unclear, with a reason when it is not met. Do not judge the pick as a whole.

Musts:
{% $frame.Musts %}

Pick: {% $weigh.Pick %}

Premortem: {% $premortem.Premortem %}
{% output name="Checks" type="map($frame.Musts, choice(met, broken, unclear))" /%}
{% derive name="Verdict" type="choice(fix, owner, pass)" %}
{% case value="fix" when=any($review.Checks, "broken") /%}
{% case value="owner" when=any($review.Checks, "unclear") /%}
{% case value="pass" /%}
{% /derive %}
{% next to="weigh" when=equals($review.Verdict, "fix") label="A must is broken: go back to weigh" max=2 exceeded="owner" /%}
{% next to="decide" when=equals($review.Verdict, "owner") label="A must is unclear: the owner decides" /%}
{% next to="done" label="All musts met: finish" /%}
{% /stage %}

{% stage id="decide" gate="user" %}
Show the owner the unclear musts with their reasons and ask: fix or pass.
{% output name="Decision" type="choice(fix, pass)" /%}
{% next to="weigh" when=equals($decide.Decision, "fix") label="The owner says fix: go back to weigh" /%}
{% next to="done" label="The owner says pass: finish" /%}
{% /stage %}

{% result name="Pick" from=$weigh.Pick /%}
{% result name="Premortem" from=$premortem.Premortem /%}

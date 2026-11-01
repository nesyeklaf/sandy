---
name: compact-composer
description: Explains the Compact Composer plugin, which limits the composer to three lines on phones and adds a toggle that hides the cards above the composer. Use when the user asks why the composer stops growing, where the recap or follow-up cards went, or how to show them again.
---

# Compact Composer

- On viewports narrower than 768px the composer grows to at most three lines of text; longer drafts scroll inside it.
- A small bar sits directly above every composer that has cards over it (recap, follow-ups, workflows, context, todos, queued messages, pending questions). "Hide" collapses all of them into one "N hidden" button; tapping that shows them again.
- The choice applies to every composer and survives reloads (localStorage per browser or device).
- Hidden cards include pending questions and approvals. If a thread waits for an answer and nothing shows, tap "N hidden".
- The plugin has no settings, CLI commands, or backend. Disable it with `sandy plugin disable compact-composer` to restore sandy's default composer.

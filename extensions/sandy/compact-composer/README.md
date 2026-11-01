# Compact Composer

SANDY plugin that saves vertical space around the composer:

- On phones (viewport below 768px) the composer grows to at most three text lines and scrolls beyond that.
- A bar at the top of the card stack above the composer hides or shows every card in it (recap, follow-ups, workflows, context, todos, ...). The bar appears only while a card shows something. Questions, approvals and plan reviews the thread waits on stay visible. The choice is shared by all composers and kept per device.

How it works: the toggle is a bare composer banner, so sandy renders it inside the composer's card stack. It counts the cards that take up space and marks the stack with `data-cc-collapsed`; `app.css` then folds every other card to height 0 (not `display: none`, so the count still works). The three-line limit is a media query on `[data-promptbox-editor-scroll]`.

Depends on sandy's composer DOM, checked against sandy 0.46.1: `data-promptbox-shell`, `data-sandy-plugin-root`, `data-promptbox-editor-scroll` and the `data-testid` values of pending interactions. They are named in `stack.ts` (the pinned list is repeated in `app.css`). If sandy renames them, the bar disappears or a pending question folds with the cards; the plugin does not crash.

Build: `npm install && sandy plugin build`. Test: `npm test`. Install: `sandy plugin install . --yes` on the sandy server host.

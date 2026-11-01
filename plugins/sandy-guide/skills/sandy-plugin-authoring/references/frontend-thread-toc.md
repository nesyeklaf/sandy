# Thread table-of-contents rail

`app.slots.experimental_threadTocExtension({ id, title, useBands, tab?, onBandClick?, onBandHover? })`
extends the thin tick rail beside an open thread (one tick per user message).
`useBands({ threadId, projectId })` is a hook returning
`{ fromSeq, toSeq, hue, label?, dashed?, active? }[]` (message seqs, hue 0-360).
Each band draws a thin vertical bracket right of the ticks over every tick
whose seq lies in the range; a range without a tick takes the next tick.
`dashed` draws a dashed line, `active` a thicker glowing one, and a click calls
`onBandClick(band, { threadId, projectId })`. Overlapping bands use up to
three lanes. `tab: { label, component }` adds a tab to the rail popover next
to Your messages and Agent messages; the component gets `threadId`,
`projectId`, `jumpToSeq(seq)`, `railSelection`, `clearRailSelection()`,
`activeSeq`, `hoveredBand`, `setHoveredRange(range)` and `openTab(id)`.
Dragging along the rail marks a range: `railSelection` is
`{ fromSeq, toSeq }` (first marked message to just before the next user
message) or null. The rail and popover stay open while it is set; Escape,
`clearRailSelection` or a thread switch clears it. A plain click behaves as
without the slot. Both the bands hook and the tab mount in crash boundaries.

`tab.experimental_default: true` opens the popover on that tab instead of Your
messages (the first registration that sets it wins); a tab the person picks
afterwards stays. `activeSeq` is the message seq of the user message at the
active position in the chat, or null. `onBandHover(band | null, input)` runs
when the pointer enters or leaves one of your brackets, and `hoveredBand`
(`{ fromSeq, toSeq } | null`) tells every tab which bracket is under the
pointer. `setHoveredRange(range | null)` highlights the bracket whose
`fromSeq`/`toSeq` equal `range` (thicker, glowing, wider ticks); the host
clears it when the panel closes or the thread changes. A plugin can register
several extensions (for example a compact `topics` list with the brackets and a
`topics-manage` panel whose `useBands` returns `[]`): each tab shows in
registration order and every registration's brackets are drawn. `openTab(id)`
switches to the tab of another registration of the same plugin by its `id`; an
id without a tab does nothing. The tab scrolls inside
the popover's own maximum height.

```ts
app.slots.experimental_threadTocExtension({
  id: "topics",
  title: "Topics",
  useBands: ({ threadId }) => useTopicBands(threadId),
  tab: { label: "Topics", component: TopicList, experimental_default: true },
  onBandHover: (band, { threadId }) => markTopic(threadId, band?.fromSeq ?? null),
});
// TopicList: onPointerEnter={() => setHoveredRange({ fromSeq, toSeq })}
```

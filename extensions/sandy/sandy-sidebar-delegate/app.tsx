// SANDY Sidebar: a shelved, manually ordered replacement for sandy's thread list.
// Manual order stays fixed until the user moves a row. Optional views can sort
// by activity, creation date, or project without changing the saved order.
import { definePluginApp } from "@sandy-sdk/plugin-sdk/app";
import "./src/theme.css";
import { ThreadInbox } from "./src/ThreadInbox";
import { ParentChip } from "./src/ParentChip";
import { SubagentsChip } from "./src/SubagentsChip";
import { SidebarSettings } from "./src/SidebarSettings";
import { TopicsTab } from "./src/TopicsTab";
import { TopicsPopover } from "./src/TopicsPopover";
import { registerTocExtension } from "./src/toc-extension";
import { useTopicBands } from "./src/useTopicBands";
import { registerAnchorActions } from "./src/anchor-actions";
import { registerBelowMetadata } from "./src/anchors-extension";
import { AnchorsBelow } from "./src/AnchorsBelow";
import { useAnchorBands } from "./src/useAnchorBands";
import { MarksTab } from "./src/MarksTab";

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "sidebar-settings",
    component: SidebarSettings,
  });

  app.slots.experimental_threadList({
    id: "inbox",
    title: "SANDY Sidebar",
    description: "Shelves, project filtering, manual ordering, and optional sorted views.",
    component: ThreadInbox,
  });

  app.slots.experimental_tab({
    id: "topics",
    title: "Topics",
    icon: "ListChecks",
    tooltip: "Topics of this session: message ranges with tags",
    context: { kind: "thread" },
    availability: "fixed",
    component: TopicsTab,
  });

  // Colored brackets beside the thread TOC rail plus a Topics tab in its panel
  // (needs the sandy fork; a host without the slot just skips it).
  registerTocExtension(app.slots, {
    id: "topics",
    title: "Topics",
    useBands: ({ threadId }) => useTopicBands(threadId),
    tab: { label: "Topics", component: TopicsPopover, experimental_default: true },
  });
  registerTocExtension(app.slots, {
    id: "topics-manage",
    title: "Manage topics",
    useBands: () => [],
    tab: { label: "Manage", component: TopicsTab },
  });

  // Marks on chat text: a pill on selected text and cards under the message
  // (needs the sandy fork; a host without the slots just skips them).
  registerAnchorActions(app.slots);
  registerTocExtension(app.slots, {
    id: "marks",
    title: "Marks",
    useBands: ({ threadId }) => useAnchorBands(threadId),
  });
  app.slots.experimental_tab({
    id: "marks",
    title: "Marks",
    icon: "Edit",
    tooltip: "Your notes, comments and tags: search them here",
    context: { kind: "thread" },
    availability: "fixed",
    component: MarksTab,
  });
  registerBelowMetadata(app.slots, { id: "anchors", placement: "below", component: AnchorsBelow });

  // Registered first, so it renders on the left of the children chip: the
  // header then reads up (parent) then down (children).
  //
  // The hidden child is otherwise a dead end — it is not in the list, so this
  // chip is its only route back to the parent.
  app.slots.experimental_threadHeaderAction({
    id: "parent",
    title: "Parent thread",
    component: ParentChip,
  });

  // A flat inbox has nowhere to nest child threads, so the list hides them
  // and this chip gives them a home on their parent's header.
  app.slots.experimental_threadHeaderAction({
    id: "children",
    title: "Child threads",
    component: SubagentsChip,
  });
});

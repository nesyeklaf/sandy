import { useMemo, useState } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { Icon, type IconName } from "./components/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "./components/Popover";
import { Tooltip } from "./components/Tooltip";
import { useInboxEnvironment } from "./InboxContext";
import { cn } from "./lib/utils";
import { useSelection } from "./SelectionHost";
import { SnoozeSelect } from "./SnoozeSelect";
import { useBulkActions } from "./useBulkActions";
import { useBulkArchive } from "./useBulkArchive";
import { useIdeaIds } from "./useIdeas";

const BAR_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-xs text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

function BarButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label}>
      <button type="button" aria-label={label} className={BAR_BUTTON} disabled={disabled} onClick={onClick}>
        <Icon name={icon} className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}

const LABEL_KINDS = {
  tag: { label: "Tag", icon: "Tag", popover: "Tag selected threads", field: "Tag name" },
  topic: { label: "Thema", icon: "Bookmark", popover: "Add selected threads to a topic", field: "Thema" },
} as const;

function LabelButton({
  kind,
  disabled,
  onSubmit,
}: {
  kind: keyof typeof LABEL_KINDS;
  disabled: boolean;
  onSubmit: (value: string) => void;
}) {
  const text = LABEL_KINDS[kind];
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip label={text.label}>
        <PopoverTrigger asChild>
          <button type="button" aria-label={text.label} className={BAR_BUTTON} disabled={disabled}>
            <Icon name={text.icon} className="size-3.5" aria-hidden />
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent align="end" side="top" aria-label={text.popover} className="w-48 p-1.5">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const value = draft.trim();
            if (!value) return;
            setDraft("");
            setOpen(false);
            onSubmit(value);
          }}
        >
          <input
            value={draft}
            aria-label={text.field}
            placeholder={text.field}
            maxLength={40}
            className="h-6 w-full rounded border border-border bg-transparent px-1.5 text-xs outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
            onChange={(event) => setDraft(event.target.value)}
          />
        </form>
      </PopoverContent>
    </Popover>
  );
}

export function SelectBar({ threads }: { threads: readonly PluginSidebarThread[] }) {
  const selection = useSelection();
  const { snoozePresets } = useInboxEnvironment();
  const archive = useBulkArchive();
  const bulk = useBulkActions();
  const ideaIds = useIdeaIds();
  const selected = useMemo(
    () => threads.filter((thread) => selection.selectedIds.has(thread.id)),
    [threads, selection.selectedIds],
  );
  if (!selection.active) return null;
  const none = selected.length === 0;
  const allPinned = !none && selected.every((thread) => thread.isPinned);
  const allIdeas = !none && selected.every((thread) => ideaIds.has(thread.id));
  const finish = () => selection.exit();
  return (
    <div
      role="toolbar"
      aria-label="Selected threads"
      className="flex shrink-0 items-center gap-0.5 border-t border-border bg-sidebar px-1.5 py-1"
    >
      <span role="status" className="min-w-0 flex-1 truncate px-1 text-xs font-medium tabular-nums">
        {selected.length} selected
      </span>
      <SnoozeSelect
        label="Snooze selected"
        snoozePresets={snoozePresets}
        disabled={none}
        triggerClassName={cn(BAR_BUTTON, "border-0 p-0")}
        onSnooze={(wake) => {
          finish();
          void bulk.snooze(selected, wake);
        }}
      />
      <BarButton
        icon="Archive"
        label="Archive"
        disabled={none}
        onClick={() => {
          finish();
          void archive(selected);
        }}
      />
      <BarButton
        icon={allPinned ? "PinOff" : "Pin"}
        label={allPinned ? "Unpin" : "Pin"}
        disabled={none}
        onClick={() => {
          finish();
          void bulk.pin(selected);
        }}
      />
      <LabelButton
        kind="tag"
        disabled={none}
        onSubmit={(tag) => {
          finish();
          void bulk.tag(selected, tag);
        }}
      />
      <LabelButton
        kind="topic"
        disabled={none}
        onSubmit={(topic) => {
          finish();
          void bulk.topic(selected, topic);
        }}
      />
      <BarButton
        icon="Bulb"
        label={allIdeas ? "Keine Idee mehr" : "Als Idee markieren"}
        disabled={none}
        onClick={() => {
          finish();
          void bulk.idea(selected, !allIdeas);
        }}
      />
      <Tooltip label="Leave select mode">
        <button type="button" aria-label="Leave select mode" className={BAR_BUTTON} onClick={finish}>
          <Icon name="Close" className="size-3.5" aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}

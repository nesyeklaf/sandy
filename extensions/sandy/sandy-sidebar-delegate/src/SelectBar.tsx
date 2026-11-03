import { useMemo, useState } from "react";
import type { PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { Icon, type IconName } from "./components/Icon";
import { Popover, PopoverContent, PopoverTrigger } from "./components/Popover";
import { useInboxEnvironment } from "./InboxContext";
import { cn } from "./lib/utils";
import { useSelection } from "./SelectionHost";
import { SnoozeSelect } from "./SnoozeSelect";
import { useBulkActions } from "./useBulkActions";
import { useBulkArchive } from "./useBulkArchive";
import { useTagIndex } from "./useTagIndex";

const BAR_BUTTON =
  "flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

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
    <button type="button" className={BAR_BUTTON} disabled={disabled} onClick={onClick}>
      <Icon name={icon} className="size-3.5" aria-hidden />
      {label}
    </button>
  );
}

function TagButton({ disabled, onTag }: { disabled: boolean; onTag: (tag: string) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={BAR_BUTTON} disabled={disabled}>
          <Icon name="Tag" className="size-3.5" aria-hidden />
          Tag
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" aria-label="Tag selected threads" className="w-48 p-1.5">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const tag = draft.trim();
            if (!tag) return;
            setDraft("");
            setOpen(false);
            onTag(tag);
          }}
        >
          <input
            value={draft}
            aria-label="Tag name"
            placeholder="Tag name"
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
  const index = useTagIndex(selection.active);
  const selected = useMemo(
    () => threads.filter((thread) => selection.selectedIds.has(thread.id)),
    [threads, selection.selectedIds],
  );
  if (!selection.active) return null;
  const none = selected.length === 0;
  const allPinned = !none && selected.every((thread) => thread.isPinned);
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
        triggerClassName={cn(BAR_BUTTON, "w-7 justify-center px-0")}
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
      <TagButton
        disabled={none}
        onTag={(tag) => {
          finish();
          void bulk.tag(selected, tag, index.threadTags);
        }}
      />
      <button
        type="button"
        aria-label="Leave select mode"
        className={cn(BAR_BUTTON, "w-7 justify-center px-0")}
        onClick={finish}
      >
        <Icon name="Close" className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

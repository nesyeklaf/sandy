import { useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { useSdk, type PluginSidebarThread } from "@sandy-sdk/plugin-sdk/app";
import { useSidebarThreads } from "./sandy-sdk";
import { Icon } from "./components/Icon";
import { toast } from "./lib/toast";
import { cn } from "./lib/utils";
import { usePortalScopeProps } from "./lib/portal-scope";

const ITEM_CLASS = cn(
  "flex cursor-pointer items-center gap-2 rounded-md px-2 py-[0.3125rem] text-xs outline-none",
  "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
);

/**
 * "In Projekt...": puts a session into one of sandy's thread sections (the
 * Tree's top level) or takes it out again. A session has at most one section.
 */
export function SectionAssignMenu({ thread }: { thread: PluginSidebarThread }) {
  const { sections } = useSidebarThreads();
  const sdk = useSdk();
  const portalScope = usePortalScopeProps();
  const [name, setName] = useState("");
  if (thread.parentThreadId != null) return null;
  const assign = (sectionId: string | null) => {
    if (sectionId === thread.sectionId) return;
    void sdk.threads.update({ threadId: thread.id, sectionId }).catch((error) => {
      toast.error("Failed to move session", {
        description: error instanceof Error ? error.message.replace(/^HTTP \d+: /, "") : undefined,
      });
    });
  };
  const createAndAssign = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setName("");
    try {
      const section = await sdk.threadSections.create({ name: trimmed });
      await sdk.threads.update({ threadId: thread.id, sectionId: section.id });
    } catch (error) {
      toast.error("Failed to create project", {
        description: error instanceof Error ? error.message.replace(/^HTTP \d+: /, "") : undefined,
      });
    }
  };
  const current = thread.sectionId ?? null;
  const choices: { id: string | null; name: string }[] = [
    ...sections.map((section) => ({ id: section.id, name: section.name })),
    { id: null, name: "No project" },
  ];
  return (
    <ContextMenu.Sub>
      <ContextMenu.SubTrigger className="flex cursor-pointer items-center rounded-md px-2 py-[0.3125rem] text-xs outline-none data-[state=open]:bg-accent data-[highlighted]:bg-accent">
        Move to project…
        <Icon name="ChevronRight" className="ml-auto size-4 opacity-60" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          {...portalScope}
          aria-label="Move to project"
          sideOffset={4}
          className="z-50 max-h-72 min-w-44 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {choices.map((choice) => (
            <ContextMenu.Item key={choice.id ?? "none"} onSelect={() => assign(choice.id)} className={ITEM_CLASS}>
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {choice.id === current ? <Icon name="Check" className="size-3.5" aria-hidden="true" /> : null}
              </span>
              <span className="min-w-0 truncate">{choice.name}</span>
            </ContextMenu.Item>
          ))}
          <div className="mt-1 border-t border-border px-2 py-1.5">
            <input
              aria-label="New project"
              placeholder="New project…"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" || event.key === "Tab") return;
                // Keep menu typeahead and arrow navigation out of the input.
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  void createAndAssign();
                }
              }}
              className="w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

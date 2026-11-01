// sandy-plugin-thread-namer — frontend entry.
//
// Two surfaces: a button in the thread header that names the open thread on
// demand, and a settings section for choosing which agent writes the names.
import { useState } from "react";
import {
  definePluginApp,
  useRpc,
} from "@sandy-sdk/plugin-sdk/app";
import { registerHeaderAction, type LegacyHeaderActionProps } from "./legacy-header";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import { ModelPicker } from "@/components/ModelPicker";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const ACTION_LABEL = "Re-generate thread name";

/**
 * The header button. The header row is 48px of chrome with 28px controls, so
 * this stays one icon-sized button on every viewport.
 */
function RenameAction({ threadId }: LegacyHeaderActionProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [pending, setPending] = useState(false);

  async function run() {
    if (pending) return;
    setPending(true);
    try {
      const result = await rpc.call("rename", { threadId });
      if (result.ok) {
        // The sidebar and the header follow the thread row, so the new name is
        // already on screen; the toast is what confirms the click.
        toast.success("Thread renamed", { description: result.title });
      } else {
        toast.error("Could not name this thread", {
          description: result.error,
        });
      }
    } catch (error) {
      toast.error("Could not name this thread", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPending(false);
    }
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            aria-label={ACTION_LABEL}
            className="size-7 shrink-0"
            disabled={pending}
            onClick={() => void run()}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Icon
              aria-hidden
              className={cn("size-4", pending && "animate-spin")}
              name={pending ? "Spinner" : "AiContentGenerator01"}
            />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {pending ? "Naming…" : ACTION_LABEL}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export default definePluginApp((app) => {
  registerHeaderAction(app.slots, {
    id: "rename",
    title: "Thread name",
    component: RenameAction,
  });

  app.slots.settingsSection({
    id: "agent",
    title: "Naming agent",
    description:
      "Which agent writes thread names. Keep the default to reuse each thread's own model and harness, or search the catalogue for one model to always use.",
    component: ModelPicker,
  });
});

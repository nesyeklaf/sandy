import { useState } from "react";
import { useRpc } from "@sandy-sdk/plugin-sdk/app";
import { toast } from "./lib/toast";
import type { sandySidebarRpcContract } from "./contract";
import { useProjectColorOverrides } from "./ProjectColors";
import { automaticProjectColor, projectColorsById } from "./project-colors";
import { SettingRow, secondaryButtonClass } from "./settings-ui";

export function ProjectColorSetting({ projectId, projectIds }: { projectId: string; projectIds: readonly string[] }) {
  const rpc = useRpc<typeof sandySidebarRpcContract>();
  const { overrides, reload } = useProjectColorOverrides();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const color = projectColorsById(projectIds, overrides).get(projectId) ?? automaticProjectColor(projectId);
  const save = async (value: string | null) => {
    if (saving) return;
    setSaving(true);
    try {
      await rpc.call("setProjectColor", { projectId, color: value });
      await reload();
      setDraft(null);
      toast.success(value ? "Repo color saved" : "Using automatic repo color");
    } catch (error) {
      toast.error("Could not save repo color", { description: error instanceof Error ? error.message : undefined });
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingRow
      title="Color"
      description="Used when Repo colors is enabled. The automatic color stays the same when you rename the repo."
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <input
            type="color"
            aria-label="Repo color"
            value={draft ?? color}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 w-10 cursor-pointer rounded border border-border bg-background p-0.5 disabled:cursor-wait"
          />
          {draft !== null && draft !== color ? (
            <button type="button" className={secondaryButtonClass} disabled={saving} onClick={() => void save(draft)}>
              {saving ? "Saving..." : "Save color"}
            </button>
          ) : null}
          {overrides[projectId] ? (
            <button type="button" className={secondaryButtonClass} disabled={saving} onClick={() => void save(null)}>
              Reset color
            </button>
          ) : null}
        </div>
      }
    />
  );
}

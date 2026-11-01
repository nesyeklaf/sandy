// One Work tab and one composer banner for the four parts. Each section is the part's own view;
// a section shows only while it has something (goal and session tasks always).
import { useEffect, useState } from "react";
import { DelegatesTab, FleetBanner, useDelegatesTabVisible } from "./delegate/app.tsx";
import { GoalBanner, GoalsTab } from "./goals/app.tsx";
import { StagesTab, useStagesVisible } from "./track/app.tsx";
import { WorkflowsTab, WorkflowStatusBanner, useWorkflowsTabVisible } from "./workflows/src/app.tsx";
import { experimental_useFixedTabTarget } from "@sandy-sdk/plugin-sdk/app";
import { WORK_TAB, type WorkSection } from "./work-tab-link.ts";

const LABELS: Record<WorkSection, string> = { goal: "Goal & tasks", stage: "Stage", delegates: "Delegates", workflows: "Workflows" };

export function WorkTab({ threadId }: { threadId: string }) {
  const visible: Record<WorkSection, boolean> = {
    goal: true,
    stage: useStagesVisible({ threadId }),
    delegates: useDelegatesTabVisible({ threadId }),
    workflows: useWorkflowsTabVisible({ threadId }),
  };
  const requested = experimental_useFixedTabTarget(WORK_TAB);
  const [chosen, setChosen] = useState<WorkSection>("goal");
  // A section a part asked for shows even before its data says it has something.
  const [asked, setAsked] = useState(false);
  useEffect(() => {
    if (requested === null) return;
    setChosen(requested.target);
    setAsked(true);
    requested.clear();
  }, [requested?.sequence]);
  const sections = (Object.keys(LABELS) as WorkSection[]).filter((section) => visible[section] || section === chosen);
  const section = visible[chosen] || asked ? chosen : "goal";
  return (
    <div className="flex h-full min-h-0 flex-col">
      {sections.length > 1 && (
        <nav className="flex shrink-0 flex-wrap gap-1 border-b border-border px-3 py-2" aria-label="Work sections">
          {sections.map((id) => (
            <button
              key={id}
              type="button"
              aria-pressed={id === section}
              onClick={() => {
                setChosen(id);
                setAsked(false);
              }}
              className={
                "rounded-md px-2 py-1 text-xs " + (id === section ? "bg-state-hover font-medium text-foreground" : "text-muted-foreground hover:bg-state-hover")
              }
            >
              {LABELS[id]}
            </button>
          ))}
        </nav>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        {section === "goal" && <GoalsTab threadId={threadId} />}
        {section === "stage" && <StagesTab threadId={threadId} />}
        {section === "delegates" && <DelegatesTab threadId={threadId} />}
        {section === "workflows" && <WorkflowsTab threadId={threadId} />}
      </div>
    </div>
  );
}

/** Goal, delegates that need the owner, and running workflows, stacked; each renders nothing when idle. */
export function WorkBanner() {
  return (
    <>
      <GoalBanner />
      <FleetBanner />
      <WorkflowStatusBanner />
    </>
  );
}

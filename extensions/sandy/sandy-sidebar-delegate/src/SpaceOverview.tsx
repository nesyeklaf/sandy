import { useState } from "react";
import { Switch } from "./settings-ui";
import type { CoordinationSettings, SpaceCoordination, SpaceMember } from "./space-coordination-contract";
import type { SpaceCoordinationState } from "./useSpaceCoordination";

function MemberRow({ member, state }: { member: SpaceMember; state: SpaceCoordinationState }) {
  const managed = member.mode === "managed";
  return (
    <li className="flex items-center gap-2 py-1">
      <span className="min-w-0 flex-1 truncate" title={member.title}>
        {member.title || member.threadId}
      </span>
      {member.latestReport === null ? null : (
        <span className="text-2xs text-muted-foreground" title={member.latestReport.summary}>
          reported {member.latestReport.outcome}
        </span>
      )}
      <span className="text-2xs text-muted-foreground">{member.status}</span>
      <Switch
        label={`Managed: ${member.title || member.threadId}`}
        checked={managed}
        onChange={(next) =>
          void state.act("Could not change the mode", () =>
            state.rpc.call("setMemberMode", { threadId: member.threadId, mode: next ? "managed" : "independent" }),
          )
        }
      />
    </li>
  );
}

function OrchestratorList({ space, state }: { space: SpaceCoordination; state: SpaceCoordinationState }) {
  const [candidate, setCandidate] = useState("");
  const titleOf = (threadId: string) => space.members.find((member) => member.threadId === threadId)?.title || threadId;
  const candidates = space.members.filter((member) => !member.isOrchestrator);
  const setOrchestrator = (threadId: string, orchestrator: boolean) =>
    state.act("Could not change the orchestrator", () => state.rpc.call("setOrchestrator", { threadId, orchestrator }));
  return (
    <section aria-label="Orchestrators" className="flex flex-col gap-1">
      <h3 className="font-semibold">Orchestrators</h3>
      {space.orchestratorThreadIds.length === 0 ? <p className="text-muted-foreground">None yet.</p> : null}
      <ul>
        {space.orchestratorThreadIds.map((threadId) => (
          <li key={threadId} className="flex items-center gap-2 py-0.5">
            <span className="min-w-0 flex-1 truncate">{titleOf(threadId)}</span>
            <button
              type="button"
              aria-label={`Remove orchestrator ${titleOf(threadId)}`}
              onClick={() => void setOrchestrator(threadId, false)}
              className="rounded px-1.5 py-0.5 text-2xs hover:bg-accent max-md:min-h-9"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-1">
        <select
          aria-label="Session to add as orchestrator"
          value={candidate}
          onChange={(event) => setCandidate(event.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-1 text-xs"
        >
          <option value="">Add orchestrator…</option>
          {candidates.map((member) => (
            <option key={member.threadId} value={member.threadId}>
              {member.title || member.threadId}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={candidate === ""}
          onClick={() => {
            void setOrchestrator(candidate, true);
            setCandidate("");
          }}
          className="h-7 rounded border border-border px-2 text-xs hover:bg-accent disabled:opacity-50 max-md:h-9"
        >
          Add
        </button>
      </div>
    </section>
  );
}

const CHECK_IN_CHOICES_MINUTES = [0, 5, 10, 15, 30, 60, 120] as const;

function checkInLabel(minutes: number): string {
  return minutes === 0 ? "Off" : `Every ${minutes} min`;
}

function CoordinationSettingsSection({ space, state }: { space: SpaceCoordination; state: SpaceCoordinationState }) {
  const change = (next: Partial<CoordinationSettings>) =>
    void state.act("Could not change the settings", () =>
      state.rpc.call("setSpaceCoordinationSettings", { spaceId: space.spaceId, ...next }),
    );
  const minutes = space.settings.checkInMinutes;
  const choices = CHECK_IN_CHOICES_MINUTES.some((choice) => choice === minutes)
    ? [...CHECK_IN_CHOICES_MINUTES]
    : [...CHECK_IN_CHOICES_MINUTES, minutes].sort((left, right) => left - right);
  return (
    <section aria-label="Orchestrator updates" className="flex flex-col gap-1">
      <h3 className="font-semibold">Orchestrator updates</h3>
      <div className="flex items-center gap-2">
        <span className="flex-1">Managed members report when done or blocked</span>
        <Switch
          label="Self-reports"
          checked={space.settings.selfReports}
          onChange={(selfReports) => change({ selfReports })}
        />
      </div>
      <label className="flex items-center gap-2">
        <span className="flex-1">Check in on managed members</span>
        <select
          aria-label="Check-in interval"
          value={minutes}
          onChange={(event) => change({ checkInMinutes: Number(event.target.value) })}
          className="h-7 rounded border border-border bg-background px-1 text-xs max-md:h-9"
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {checkInLabel(choice)}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <span className="flex-1">Tell orchestrators about failures and questions</span>
        <Switch
          label="Failure fallback"
          checked={space.settings.failureFallback}
          onChange={(failureFallback) => change({ failureFallback })}
        />
      </div>
    </section>
  );
}

export function SpaceOverview({ space, state }: { space: SpaceCoordination; state: SpaceCoordinationState }) {
  return (
    <div className="flex flex-col gap-3 overflow-y-auto">
      <OrchestratorList space={space} state={state} />
      <CoordinationSettingsSection space={space} state={state} />
      <section aria-label="Members" className="flex flex-col gap-1">
        <h3 className="font-semibold">Members</h3>
        <p className="text-2xs text-muted-foreground">
          Managed members follow the orchestrators; independent ones do not.
        </p>
        <ul className="divide-y divide-border">
          {space.members.map((member) => (
            <MemberRow key={member.threadId} member={member} state={state} />
          ))}
        </ul>
        {space.membersTruncated ? (
          <p className="text-2xs text-muted-foreground">More sessions are not listed.</p>
        ) : null}
      </section>
    </div>
  );
}

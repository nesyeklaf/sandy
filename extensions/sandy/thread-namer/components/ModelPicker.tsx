// The plugin's own model picker: a search box over the model catalogue that
// filters the way the prompt input's model-and-reasoning picker does, plus the
// reasoning efforts of whichever model is selected.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@sandy-sdk/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../server";
import {
  filterModelChoices,
  groupChoicesByProvider,
  isSelectedChoice,
  reasoningLabel,
  withSelectionChoice,
  type AgentSelection,
  type ModelChoice,
  type ReasoningLevel,
} from "../lib/models";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Catalog {
  selection: AgentSelection | null;
  choices: ModelChoice[];
  unavailable: string[];
  pending: string[];
  discovering: boolean;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; catalog: Catalog };

export function ModelPicker() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      // Keep whatever is already listed: a refresh, or a partial catalogue
      // arriving over realtime, must not blank the list.
      setState((current) =>
        current.status === "ready" ? current : { status: "loading" },
      );
      try {
        setState({
          status: "ready",
          catalog: await rpc.call("catalog", { refresh }),
        });
      } catch (error) {
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [rpc],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Discovery publishes each agent's models as they land.
  useRealtime("catalog", () => void load(false));

  if (state.status === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon aria-hidden className="size-4 animate-spin" name="Spinner" />
        Loading models…
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="space-y-2">
        <p className="text-sm text-destructive">{state.message}</p>
        <Button onClick={() => void load(true)} size="sm" variant="outline">
          Try again
        </Button>
      </div>
    );
  }

  const catalog = state.catalog;
  const { selection, choices, unavailable, pending, discovering } = catalog;
  const listed = filterModelChoices(
    withSelectionChoice(choices, selection),
    query,
  );
  const groups = groupChoicesByProvider(listed);

  async function select(next: AgentSelection | null) {
    setSaving(true);
    try {
      const saved = await rpc.call("selectAgent", { selection: next });
      setState({
        status: "ready",
        catalog: { ...catalog, selection: saved.selection },
      });
      toast.success(
        next === null
          ? "Names follow each thread's own agent"
          : `Names are written by ${next.model}`,
      );
    } catch (error) {
      toast.error("Could not save the agent", {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-3">
      <ChoiceRow
        description="Reuses the model and harness that thread's own prompts run on."
        disabled={saving}
        label="The thread's own agent"
        onSelect={() => void select(null)}
        selected={selection === null}
      />

      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Icon
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            name="Search"
          />
          <Input
            aria-label="Search models"
            className="pl-8"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            value={query}
          />
        </div>
        <Button
          aria-label="Reload models"
          disabled={discovering}
          onClick={() => void load(true)}
          size="icon"
          variant="ghost"
        >
          <Icon
            aria-hidden
            className={cn("size-4", discovering && "animate-spin")}
            name="RotateCcw"
          />
        </Button>
      </div>

      <div className="max-h-80 space-y-3 overflow-y-auto">
        {groups.map((group) => (
          <div className="space-y-0.5" key={group.providerId}>
            <p className="px-2 text-xs font-medium text-muted-foreground">
              {group.providerName}
            </p>
            {group.choices.map((choice) => {
              const selected = isSelectedChoice(choice, selection);
              return (
                <div key={`${choice.providerId}/${choice.model}`}>
                  <ChoiceRow
                    description={choice.description}
                    disabled={saving}
                    label={choice.label}
                    onSelect={() =>
                      void select({
                        providerId: choice.providerId,
                        model: choice.model,
                        reasoningLevel: null,
                      })
                    }
                    selected={selected}
                  />
                  {selected && choice.reasoning.length > 1 ? (
                    <ReasoningRow
                      choice={choice}
                      disabled={saving}
                      onSelect={(level) =>
                        void select({
                          providerId: choice.providerId,
                          model: choice.model,
                          reasoningLevel: level,
                        })
                      }
                      selected={selection?.reasoningLevel ?? null}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        ))}
        {groups.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {query.trim() === ""
              ? "No agent reported any models."
              : "No models match your search."}
          </p>
        ) : null}
      </div>

      {pending.length > 0 ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Icon aria-hidden className="size-3.5 animate-spin" name="Spinner" />
          Loading models from {pending.join(", ")}…
        </p>
      ) : null}

      {unavailable.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          No models from {unavailable.join(", ")}. Sign in to those agents to
          pick one of their models.
        </p>
      ) : null}
    </div>
  );
}

/** The reasoning efforts of the selected model, as a row of chips. */
function ReasoningRow({
  choice,
  disabled,
  onSelect,
  selected,
}: {
  choice: ModelChoice;
  disabled: boolean;
  onSelect: (level: ReasoningLevel | null) => void;
  selected: ReasoningLevel | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 pb-1 pl-8 pt-1">
      <span className="pr-1 text-xs text-muted-foreground">Reasoning</span>
      <ReasoningChip
        disabled={disabled}
        description="Whatever the model uses by default."
        label={`Default (${reasoningLabel(choice.defaultReasoningLevel)})`}
        onSelect={() => onSelect(null)}
        selected={selected === null}
      />
      {choice.reasoning.map((effort) => (
        <ReasoningChip
          description={effort.description}
          disabled={disabled}
          key={effort.level}
          label={reasoningLabel(effort.level)}
          onSelect={() => onSelect(effort.level)}
          selected={selected === effort.level}
        />
      ))}
    </div>
  );
}

function ReasoningChip({
  description,
  disabled,
  label,
  onSelect,
  selected,
}: {
  description: string;
  disabled: boolean;
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <Button
      // The chip shows the effort; the description is what it means, and the
      // vendored button deliberately has no native `title`.
      aria-label={description === "" ? label : `${label} — ${description}`}
      aria-pressed={selected}
      className={cn(
        "h-6 rounded-full px-2.5 text-xs font-normal",
        selected && "bg-accent text-accent-foreground",
      )}
      disabled={disabled}
      onClick={onSelect}
      type="button"
      variant="ghost"
    >
      {label}
    </Button>
  );
}

function ChoiceRow({
  description,
  disabled,
  label,
  onSelect,
  selected,
}: {
  description: string;
  disabled: boolean;
  label: string;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <Button
      aria-pressed={selected}
      className="h-auto w-full justify-start gap-2 px-2 py-1.5 text-left"
      disabled={disabled}
      onClick={onSelect}
      type="button"
      variant="ghost"
    >
      <Icon
        aria-hidden
        className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
        name="Check"
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-normal">{label}</span>
        {description === "" ? null : (
          <span className="block truncate text-xs font-normal text-muted-foreground">
            {description}
          </span>
        )}
      </span>
    </Button>
  );
}

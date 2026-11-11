import { useEffect, useState } from "react";
import type { Scratchpad } from "./space-coordination-contract";
import type { SpaceCoordinationState } from "./useSpaceCoordination";

export function SpaceScratchpad({ spaceId, state }: { spaceId: string; state: SpaceCoordinationState }) {
  const { rpc } = state;
  const [saved, setSaved] = useState<Scratchpad | null>(null);
  const [draft, setDraft] = useState("");
  const [conflict, setConflict] = useState<Scratchpad | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    rpc.call("getScratchpad", { spaceId }).then(
      (pad) => {
        if (!live) return;
        setSaved(pad);
        setDraft(pad.body);
      },
      (failure: unknown) => live && setError(failure instanceof Error ? failure.message : "Request failed"),
    );
    return () => {
      live = false;
    };
  }, [rpc, spaceId]);
  const save = async (baseRevision: number) => {
    setBusy(true);
    try {
      const result = await rpc.call("writeScratchpad", { spaceId, body: draft, baseRevision });
      if (result.status === "written") {
        setSaved(result.scratchpad);
        setConflict(null);
      } else setConflict(result.scratchpad);
      setError(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Request failed");
    } finally {
      setBusy(false);
    }
  };
  if (saved === null)
    return error === null ? <p className="text-muted-foreground">Loading…</p> : <p role="alert">{error}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <textarea
        aria-label="Scratchpad"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Markdown notes shared by this Space's sessions"
        className="min-h-40 flex-1 resize-none rounded border border-border bg-background p-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      {conflict !== null ? (
        <div role="alert" className="flex flex-col gap-1 rounded border border-destructive/50 p-2">
          <p className="font-medium">Someone changed the scratchpad. Your draft is kept.</p>
          <pre
            aria-label="Current scratchpad"
            className="max-h-40 overflow-auto whitespace-pre-wrap font-mono text-2xs"
          >
            {conflict.body}
          </pre>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setDraft(conflict.body);
                setSaved(conflict);
                setConflict(null);
              }}
              className="rounded border border-border px-2 py-1 hover:bg-accent max-md:min-h-9"
            >
              Use current text
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void save(conflict.revision)}
              className="rounded border border-border px-2 py-1 hover:bg-accent disabled:opacity-50 max-md:min-h-9"
            >
              Overwrite with my draft
            </button>
          </div>
        </div>
      ) : null}
      {error !== null ? (
        <p role="alert" className="text-2xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || draft === saved.body}
          onClick={() => void save(saved.revision)}
          className="rounded bg-primary px-3 py-1 font-medium text-primary-foreground disabled:opacity-50 max-md:min-h-9"
        >
          Save
        </button>
        <span className="text-2xs text-muted-foreground">Revision {saved.revision}</span>
      </div>
    </div>
  );
}

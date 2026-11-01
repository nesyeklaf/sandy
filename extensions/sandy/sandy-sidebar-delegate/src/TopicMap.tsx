import type { CSSProperties } from "react";
import type { MapRun } from "./topic-layout";
import "./topics.css";

/** The whole session as one bar: a colored segment per topic, grey where no topic covers it. */
export function TopicMap({
  runs,
  isDimmed,
  onJump,
}: {
  runs: readonly MapRun[];
  isDimmed: (run: MapRun) => boolean;
  onJump: (seq: number) => void;
}) {
  return (
    <div className="sandy-topics-map" role="group" aria-label="Session overview">
      {runs.map((run) => (
        <button
          key={`${run.firstSeq}-${run.owner?.key ?? "none"}`}
          type="button"
          className="sandy-topics-seg"
          style={{ flexGrow: run.weight, "--h": run.owner?.hue } as CSSProperties}
          data-owner={run.owner ? "topic" : "none"}
          data-suggested={run.owner?.suggested ? "" : undefined}
          data-dim={isDimmed(run) ? "" : undefined}
          aria-label={run.owner ? run.owner.title : "No topic"}
          title={run.owner ? run.owner.title : "No topic"}
          onClick={() => onJump(run.firstSeq)}
        />
      ))}
    </div>
  );
}

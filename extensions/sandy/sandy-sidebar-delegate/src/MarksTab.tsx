import { useSandyNavigate } from "@sandy-sdk/plugin-sdk/app";
import { useState } from "react";
import type { Anchor } from "./anchors-contract";
import { useAnchorSearch } from "./useAnchorSearch";
import "./anchors.css";

type Kind = Anchor["kind"];
const KINDS: readonly Kind[] = ["note", "comment", "tag", "link", "bookmark"];

/** Every mark you made, searchable: this session by default, all sessions on request. */
export function MarksTab({ threadId }: { threadId: string }) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Anchor["kind"] | null>(null);
  const [everywhere, setEverywhere] = useState(false);
  const navigate = useSandyNavigate();
  const { anchors, loading, error } = useAnchorSearch({ query, kind, threadId: everywhere ? null : threadId });

  const open = (anchor: Anchor) =>
    navigate.toThread(
      anchor.threadId,
      anchor.seq === null
        ? undefined
        : ({ experimental_messageSeq: anchor.seq } as Parameters<typeof navigate.toThread>[1]),
    );

  return (
    <div className="sandy-marks">
      <input
        className="sandy-anchor-input"
        type="search"
        placeholder="Search your marks"
        aria-label="Search your marks"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="sandy-marks-filters" role="group" aria-label="Filter marks">
        <button type="button" aria-pressed={kind === null} onClick={() => setKind(null)}>
          All
        </button>
        {KINDS.map((entry) => (
          <button
            key={entry}
            type="button"
            data-kind={entry}
            aria-pressed={kind === entry}
            onClick={() => setKind(entry)}
          >
            {entry}
          </button>
        ))}
        <button
          type="button"
          className="sandy-marks-scope"
          aria-pressed={everywhere}
          onClick={() => setEverywhere((value) => !value)}
        >
          All sessions
        </button>
      </div>
      {error !== null ? <div className="sandy-anchor-error">{error}</div> : null}
      {!loading && error === null && anchors.length === 0 ? (
        <div className="sandy-marks-empty">
          {query !== "" || kind !== null ? "No marks match." : "Select text in the chat to add a note, comment or tag."}
        </div>
      ) : null}
      <ul className="sandy-marks-list">
        {anchors.map((anchor) => (
          <li key={anchor.id}>
            <button
              type="button"
              className="sandy-anchor-card sandy-marks-item"
              data-kind={anchor.kind}
              data-author={anchor.author}
              onClick={() => open(anchor)}
            >
              <span className="sandy-anchor-label">
                {anchor.author === "agent" ? "Agent " + anchor.kind : anchor.kind}
                {everywhere ? " · " + anchor.threadId : ""}
              </span>
              {anchor.quote !== "" ? <span className="sandy-anchor-quote">{anchor.quote}</span> : null}
              {anchor.body !== "" ? <span className="sandy-anchor-body">{anchor.body}</span> : null}
              {anchor.tags.length > 0 ? (
                <span className="sandy-anchor-tags">
                  {anchor.tags.map((tag) => (
                    <span key={tag} className="sandy-anchor-tag">
                      #{tag}
                    </span>
                  ))}
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

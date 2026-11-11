import { useState } from "react";
import { IDEA_STATUSES, type Idea, type IdeaStatus, type SpaceCoordination } from "./space-coordination-contract";
import type { SpaceCoordinationState } from "./useSpaceCoordination";

function titleOf(space: SpaceCoordination, threadId: string): string {
  return space.members.find((member) => member.threadId === threadId)?.title || threadId;
}

function IdeaEditor({
  idea,
  space,
  state,
  onDone,
}: {
  idea: Idea;
  space: SpaceCoordination;
  state: SpaceCoordinationState;
  onDone: () => void;
}) {
  const [title, setTitle] = useState(idea.title);
  const [body, setBody] = useState(idea.body);
  const [status, setStatus] = useState<IdeaStatus>(idea.status);
  const [links, setLinks] = useState<readonly string[]>(idea.threadIds);
  const toggle = (threadId: string) =>
    setLinks((current) =>
      current.includes(threadId) ? current.filter((id) => id !== threadId) : [...current, threadId],
    );
  const save = async () => {
    const ok = await state.act("Could not save the idea", () =>
      state.rpc.call("updateIdea", { ideaId: idea.id, title, body, status, threadIds: [...links] }),
    );
    if (ok) onDone();
  };
  return (
    <form
      aria-label={`Edit idea ${idea.title}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      className="flex flex-col gap-1"
    >
      <input
        aria-label="Idea title"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        className="h-7 rounded border border-border bg-background px-1.5 text-xs"
      />
      <textarea
        aria-label="Idea body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className="min-h-16 rounded border border-border bg-background p-1.5 text-xs"
      />
      <select
        aria-label="Idea status"
        value={status}
        onChange={(event) => setStatus(event.target.value as IdeaStatus)}
        className="h-7 rounded border border-border bg-background px-1 text-xs"
      >
        {IDEA_STATUSES.map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>
      <fieldset className="flex flex-col gap-0.5">
        <legend className="text-2xs text-muted-foreground">Linked sessions</legend>
        {space.members.map((member) => (
          <label key={member.threadId} className="flex items-center gap-1.5">
            <input type="checkbox" checked={links.includes(member.threadId)} onChange={() => toggle(member.threadId)} />
            <span className="truncate">{member.title || member.threadId}</span>
          </label>
        ))}
      </fieldset>
      <div className="flex gap-2">
        <button
          type="submit"
          className="rounded bg-primary px-3 py-1 font-medium text-primary-foreground max-md:min-h-9"
        >
          Save idea
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded border border-border px-3 py-1 hover:bg-accent max-md:min-h-9"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function IdeaItem({ idea, space, state }: { idea: Idea; space: SpaceCoordination; state: SpaceCoordinationState }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <IdeaEditor idea={idea} space={space} state={state} onDone={() => setEditing(false)} />;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-medium">{idea.title}</span>
        <span className="rounded bg-accent px-1.5 text-2xs">{idea.status}</span>
      </div>
      {idea.body !== "" ? <p className="whitespace-pre-wrap text-muted-foreground">{idea.body}</p> : null}
      {idea.threadIds.length > 0 ? (
        <p className="text-2xs text-muted-foreground">
          Linked: {idea.threadIds.map((id) => titleOf(space, id)).join(", ")}
        </p>
      ) : null}
      <div className="flex gap-2">
        <button
          type="button"
          aria-label={`Edit ${idea.title}`}
          onClick={() => setEditing(true)}
          className="rounded px-1.5 py-0.5 text-2xs hover:bg-accent max-md:min-h-9"
        >
          Edit
        </button>
        <button
          type="button"
          aria-label={`Delete ${idea.title}`}
          onClick={() =>
            void state.act("Could not delete the idea", () => state.rpc.call("deleteIdea", { ideaId: idea.id }))
          }
          className="rounded px-1.5 py-0.5 text-2xs text-destructive hover:bg-accent max-md:min-h-9"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function NewIdea({ space, state }: { space: SpaceCoordination; state: SpaceCoordinationState }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const submit = async () => {
    const ok = await state.act("Could not create the idea", () =>
      state.rpc.call("createIdea", { spaceId: space.spaceId, title: title.trim(), body, threadIds: [] }),
    );
    if (!ok) return;
    setTitle("");
    setBody("");
  };
  return (
    <form
      aria-label="New idea"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-1"
    >
      <input
        aria-label="New idea title"
        placeholder="New idea"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        className="h-7 rounded border border-border bg-background px-1.5 text-xs"
      />
      <textarea
        aria-label="New idea details"
        placeholder="Details (optional)"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        className="min-h-12 rounded border border-border bg-background p-1.5 text-xs"
      />
      <button
        type="submit"
        disabled={title.trim() === ""}
        className="self-start rounded border border-border px-3 py-1 hover:bg-accent disabled:opacity-50 max-md:min-h-9"
      >
        Add idea
      </button>
    </form>
  );
}

export function SpaceIdeas({ space, state }: { space: SpaceCoordination; state: SpaceCoordinationState }) {
  return (
    <div className="flex flex-col gap-3 overflow-y-auto">
      <NewIdea space={space} state={state} />
      {space.ideas.length === 0 ? <p className="text-muted-foreground">No ideas yet.</p> : null}
      <ul className="flex flex-col gap-3">
        {space.ideas.map((idea) => (
          <li key={idea.id}>
            <IdeaItem idea={idea} space={space} state={state} />
          </li>
        ))}
      </ul>
    </div>
  );
}

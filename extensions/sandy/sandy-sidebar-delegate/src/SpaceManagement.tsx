import { useRef, useState, type FormEvent, type RefObject } from "react";
import { useSdk } from "@sandy-sdk/plugin-sdk/app";
import { Icon } from "./components/Icon";

function reason(error: unknown): string {
  return error instanceof Error ? error.message.replace(/^HTTP \d+: /, "") : "Request failed";
}

function NameForm({
  label,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await onSubmit(name.trim());
    } catch (failure) {
      setError(reason(failure));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-1 flex-col gap-1">
      <div className="flex items-center gap-1">
        <input
          autoFocus
          aria-label={label}
          aria-invalid={error !== null}
          value={name}
          disabled={busy}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onCancel();
            }
          }}
          className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
        <button
          type="submit"
          disabled={busy}
          aria-label={submitLabel}
          className="grid size-6 place-items-center rounded hover:bg-accent disabled:opacity-50"
        >
          <Icon name="Check" className="size-3.5" />
        </button>
        <button
          type="button"
          aria-label="Cancel"
          onClick={onCancel}
          className="grid size-6 place-items-center rounded hover:bg-accent"
        >
          <Icon name="Close" className="size-3.5" />
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-2xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function CreateSpaceForm() {
  const sdk = useSdk();
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-2xs text-muted-foreground hover:bg-sidebar-accent"
      >
        <span aria-hidden="true">+</span> New Space
      </button>
    );
  }
  return (
    <div className="mt-2 px-1">
      <NameForm
        label="New Space name"
        initial=""
        submitLabel="Create Space"
        onCancel={() => setOpen(false)}
        onSubmit={async (name) => {
          await sdk.threadSections.create({ name });
          setOpen(false);
        }}
      />
    </div>
  );
}

export function SpaceActions({
  name,
  deleteRef,
  onRenaming,
  onDelete,
  onAddOrchestrator,
}: {
  name: string;
  deleteRef: RefObject<HTMLButtonElement | null>;
  onRenaming: (renaming: boolean) => void;
  onDelete: () => void;
  onAddOrchestrator: () => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label={`Add orchestrator to ${name}`}
        title="Add orchestrator…"
        onClick={onAddOrchestrator}
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent"
      >
        <Icon name="Orchestrator" className="size-3" />
      </button>
      <button
        type="button"
        aria-label={`Rename ${name}`}
        onClick={() => onRenaming(true)}
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent"
      >
        <Icon name="Edit" className="size-3" />
      </button>
      <button
        ref={deleteRef}
        type="button"
        aria-label={`Delete ${name}`}
        onClick={onDelete}
        className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent"
      >
        <Icon name="Close" className="size-3" />
      </button>
    </>
  );
}

export function SpaceDeleteConfirm({
  spaceId,
  name,
  total,
  onClose,
}: {
  spaceId: string;
  name: string;
  total: number;
  onClose: () => void;
}) {
  const sdk = useSdk();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const remove = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      await sdk.threadSections.delete({ id: spaceId });
      onClose();
    } catch (failure) {
      setError(reason(failure));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  return (
    <div
      role="group"
      aria-label={`Delete Space ${name}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onClose();
        }
      }}
      className="mt-1 flex flex-col gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
    >
      <p className="font-medium">Delete Space “{name}”?</p>
      <p className="text-2xs leading-4 text-muted-foreground">
        {total === 0
          ? "The Space is empty."
          : `Its ${total === 1 ? "session moves" : `${total} sessions move`} to No Space.`}{" "}
        Sessions, their workers and repositories are kept. Its ideas and scratchpad are kept and can be adopted by
        another Space with sandy spaces adopt.
      </p>
      {error ? (
        <p role="alert" className="text-2xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={onClose}
          className="h-7 rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-accent disabled:opacity-50 max-md:h-9"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void remove()}
          className="h-7 rounded-md bg-destructive px-3 text-xs font-medium text-destructive-foreground hover:opacity-90 disabled:opacity-50 max-md:h-9"
        >
          {busy ? "Deleting..." : "Delete Space"}
        </button>
      </div>
    </div>
  );
}

export function SpaceRenameForm({ spaceId, name, onDone }: { spaceId: string; name: string; onDone: () => void }) {
  const sdk = useSdk();
  return (
    <NameForm
      label={`Rename ${name}`}
      initial={name}
      submitLabel="Save name"
      onCancel={onDone}
      onSubmit={async (next) => {
        await sdk.threadSections.update({ id: spaceId, name: next });
        onDone();
      }}
    />
  );
}

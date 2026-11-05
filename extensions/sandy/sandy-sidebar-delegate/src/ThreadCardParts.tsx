import { Icon } from "./components/Icon";
import { cn } from "./lib/utils";

export function ParkButton({
  label,
  settling,
  onActivate,
}: {
  label: string;
  settling: boolean;
  onActivate: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      data-settling={settling ? "" : undefined}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onActivate();
      }}
      className={cn(
        "sandy-sidebar-settle relative flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground",
        "transition-colors duration-200 ease-out hover:text-[color:var(--sandy-sidebar-settle-active)]",
        "focus-visible:text-[color:var(--sandy-sidebar-settle-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
        "motion-reduce:transition-none",
        settling && "text-[color:var(--sandy-sidebar-settle-active)]",
      )}
    >
      <span
        aria-hidden="true"
        className="sandy-sidebar-settle-art pointer-events-none relative flex size-full items-center justify-center rounded-[inherit]"
      >
        <Icon name="Check" aria-hidden className="sandy-sidebar-settle-check size-3.5" />
        <span className="sandy-sidebar-settle-stars">
          {[0, 1, 2].map((star) => (
            <span key={star} className="sandy-sidebar-settle-star" />
          ))}
        </span>
      </span>
    </button>
  );
}

export function ActivityCount({ label, count }: { label: string; count: number }) {
  return (
    <span
      aria-label={`${count} ${label}`}
      className="shrink-0 rounded bg-muted px-1 font-mono text-2xs text-muted-foreground"
    >
      {count}
    </span>
  );
}

export function SelectCheckbox({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`Select ${label}`}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className="absolute inset-0 z-10 flex cursor-pointer items-center rounded-md pl-1 outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon
        name={checked ? "CheckSquare" : "Square"}
        className={cn("size-3.5", checked ? "text-foreground" : "text-muted-foreground")}
        aria-hidden
      />
    </button>
  );
}

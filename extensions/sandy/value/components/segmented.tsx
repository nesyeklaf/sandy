// A row of mutually exclusive choices. Vendored from @danielbachhuber/bb-plugin-component-library 1.4.0 (segmented),
// whose package still imports the pre-fork SDK.
import { cn } from "../lib/utils";

export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  /** The group's accessible name. */
  label: string;
  options: ReadonlyArray<{ id: T; label: string; count?: number; title?: string }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border border-border p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={option.id === value}
          title={option.title}
          onClick={() => onChange(option.id)}
          className={cn(
            "rounded px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground",
            option.id === value && "bg-muted font-medium text-foreground",
          )}
        >
          {option.label}
          {option.count === undefined ? null : (
            <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">{option.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

import type { SandyProjectOption } from "../../shared/contract.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const NO_LINK = "__none__";

export function SandyProjectLinkPicker({
  value,
  onChange,
  sandyProjects,
  noneLabel = "Not linked",
}: {
  value: string | null;
  onChange: (value: string | null) => void;
  sandyProjects: readonly SandyProjectOption[];
  noneLabel?: string;
}) {
  const unavailableSelection =
    value !== null && !sandyProjects.some((project) => project.id === value)
      ? value
      : null;
  return (
    <Select
      value={value ?? NO_LINK}
      onValueChange={(next) => onChange(next === NO_LINK ? null : next)}
    >
      <SelectTrigger aria-label="Linked sandy project" className="h-8">
        <SelectValue>
          {sandyProjects.find((project) => project.id === value)?.name ??
            unavailableSelection ??
            noneLabel}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_LINK}>{noneLabel}</SelectItem>
        {unavailableSelection !== null ? (
          <SelectItem value={unavailableSelection}>
            Unavailable · {unavailableSelection}
          </SelectItem>
        ) : null}
        {sandyProjects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

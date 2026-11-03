export const ROW_FIELDS = ["diff", "pr", "host", "provider", "subagents", "age"] as const;
export type RowField = (typeof ROW_FIELDS)[number];
export type RowFields = Readonly<Record<RowField, boolean>>;

export const ROW_FIELD_LABELS: Record<RowField, string> = {
  diff: "Diff +/−",
  pr: "PR and checks",
  host: "Host",
  provider: "Provider",
  subagents: "Subagents",
  age: "Age",
};

export const DEFAULT_ROW_FIELDS: RowFields = {
  diff: true,
  pr: true,
  host: true,
  provider: true,
  subagents: true,
  age: true,
};

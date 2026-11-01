import {
  ReuseEnvironmentPicker,
  type ReuseThreadOption,
} from "./ReuseEnvironmentPicker";
import { StoryCard, StoryRow } from "../../../.ladle/story-card";

export default {
  title: "pickers/Reuse Environment Picker",
};

const noop = () => {};

function makeOption(
  branchName: string,
  threadTitles: readonly string[],
  hostName: string | null = null,
): ReuseThreadOption {
  return {
    environmentId: `env_${branchName.replace(/\W/gu, "_")}`,
    branchName,
    name: null,
    path: `/Users/michael/worktrees/${branchName}`,
    environmentProviderId: "git-worktree",
    hostName,
    threads: threadTitles.map((title, index) => ({
      id: `thr_${branchName}_${index}`,
      title,
    })),
  };
}

const fewOptions: readonly ReuseThreadOption[] = [
  makeOption("sandy/payment-retry", ["Fix the payment retry", "Add a regression"]),
  makeOption("sandy/sidebar-perf", ["Profile the sidebar"]),
  makeOption("sandy/release-1.2", []),
];

const manyOptions: readonly ReuseThreadOption[] = [
  ...fewOptions,
  makeOption("sandy/composer-reuse", ["Restore the reuse row"], "Michael-M4"),
  makeOption("sandy/machine-picker", ["Group by machine"], "studio-mac-mini"),
  makeOption("sandy/plugin-guide", ["Document the slots"], "Michael-M4"),
  makeOption("sandy/acp-provider", ["Custom models"], "build-box"),
  makeOption("sandy/timeline-qa", ["Timeline smoke pass"], "build-box"),
];

export function Overview() {
  return (
    <StoryCard>
      <StoryRow
        label="nothing to reuse"
        hint="project has no environment with a live thread"
      >
        <ReuseEnvironmentPicker
          options={[]}
          value={null}
          onChange={noop}
          modal={false}
        />
      </StoryRow>
      <StoryRow
        label="a few environments"
        hint="below the search threshold — no search input"
      >
        <ReuseEnvironmentPicker
          options={fewOptions}
          value={null}
          onChange={noop}
          modal={false}
        />
      </StoryRow>
      <StoryRow
        label="one selected"
        hint="trigger shows the chosen environment"
      >
        <ReuseEnvironmentPicker
          options={fewOptions}
          value={fewOptions[0]?.environmentId ?? null}
          onChange={noop}
          modal={false}
        />
      </StoryRow>
      <StoryRow label="disabled" hint="no chevron, not interactive">
        <ReuseEnvironmentPicker
          options={fewOptions}
          value={fewOptions[0]?.environmentId ?? null}
          onChange={noop}
          disabled
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}

export function Searchable() {
  return (
    <StoryCard>
      <StoryRow
        label="enough environments to search"
        hint="search filters on branch, machine, and thread titles"
      >
        <ReuseEnvironmentPicker
          options={manyOptions}
          value={null}
          onChange={noop}
          modal={false}
        />
      </StoryRow>
    </StoryCard>
  );
}

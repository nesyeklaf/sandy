import type { FeatureFlags } from "@sandy/domain";
import {
  readEnvVarWithDefault,
  resolveEnvLoader,
  type EnvLoaderArgs,
} from "./env.js";
import {
  SANDY_FF_PLACEHOLDER_ENV,
  SANDY_FF_TIMELINE_WINDOW_EVENT_BUDGET_ENV,
  DEFAULT_SANDY_FF_PLACEHOLDER,
  DEFAULT_SANDY_FF_TIMELINE_WINDOW_EVENT_BUDGET,
} from "./env-vars.js";

type LoadFeatureFlagsArgs = EnvLoaderArgs;

export function loadFeatureFlags(
  args: LoadFeatureFlagsArgs = {},
): FeatureFlags {
  const loader = resolveEnvLoader(args);
  return {
    placeholder: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_SANDY_FF_PLACEHOLDER,
      definition: SANDY_FF_PLACEHOLDER_ENV,
      env: loader.env,
    }),
    timelineWindowEventBudget: readEnvVarWithDefault({
      context: loader.context,
      defaultValue: DEFAULT_SANDY_FF_TIMELINE_WINDOW_EVENT_BUDGET,
      definition: SANDY_FF_TIMELINE_WINDOW_EVENT_BUDGET_ENV,
      env: loader.env,
    }),
  };
}

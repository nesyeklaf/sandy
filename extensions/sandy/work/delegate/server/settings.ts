// Plugin settings of sandy/delegate. The descriptors have the shape of SANDY's PluginSettingDescriptor
// (number type), so the server registers them as they are with sandy.settings.define.

export type DelegateSettings = {
  // Slots per root thread: delegations of the root in reserved|starting|active, workflows-plus workers included.
  maxConcurrentChildren: number;
  // Longest a single sandy_delegate / sandy_delegate_wait call blocks; a plugin tool call is cut at ~300 s (P2).
  waitCeilingMs: number;
  // A child that has not acked its policy this long after its thread was bound to its ledger row is stopped and marked refused.
  briefWatchdogSeconds: number;
  // An open child question expires after this many days (sandy.ui.requestInput caps timeoutMs at 7 days).
  questionTimeoutDays: number;
};

export const DEFAULT_SETTINGS: DelegateSettings = {
  maxConcurrentChildren: 4,
  waitCeilingMs: 270_000,
  briefWatchdogSeconds: 120,
  questionTimeoutDays: 7,
};

type NumberSettingDescriptor = { type: "number"; label: string; description: string; default: number };

export const SETTING_DESCRIPTORS: Record<keyof DelegateSettings, NumberSettingDescriptor> = {
  maxConcurrentChildren: {
    type: "number",
    label: "Max running children per root",
    description: "Delegates and workflows-plus workers of one root thread that may run at once; more wait in a queue.",
    default: DEFAULT_SETTINGS.maxConcurrentChildren,
  },
  waitCeilingMs: {
    type: "number",
    label: "Wait chunk (ms)",
    description: "Longest a foreground delegation blocks per call before it returns waitTimedOut.",
    default: DEFAULT_SETTINGS.waitCeilingMs,
  },
  briefWatchdogSeconds: {
    type: "number",
    label: "Ack watchdog (s)",
    description: "A child without a policy ack this long after it was spawned, or after any later turn started, is stopped and marked refused.",
    default: DEFAULT_SETTINGS.briefWatchdogSeconds,
  },
  questionTimeoutDays: {
    type: "number",
    label: "Question timeout (days)",
    description: "An unanswered child question expires after this many days.",
    default: DEFAULT_SETTINGS.questionTimeoutDays,
  },
};

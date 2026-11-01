// The realtime channels server.ts publishes on and app.tsx listens to. They
// live apart from contract.ts so the app can import them without bundling the
// SDK's root entry, which a marketplace install leaves out with the other
// devDependencies.

/** Published with `{ threadIds }` after new usage is recorded. */
export const USAGE_CHANNEL = "usage-changed";

/** Published with `{ threadIds }` after a thread's context size is recorded. */
export const CONTEXT_CHANNEL = "context-changed";

/** Published after a new reading of the subscriptions' usage limits is stored. */
export const LIMITS_CHANNEL = "limits-changed";

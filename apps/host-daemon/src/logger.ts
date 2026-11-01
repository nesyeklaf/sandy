import type { Logger } from "@sandy/logger";

export type HostDaemonLogger = Pick<
  Logger,
  "debug" | "info" | "warn" | "error"
>;

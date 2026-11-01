import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

export default function draftsPlugin(sandy: SandyPluginApi): void {
  sandy.experimental_hooks.on("message.dispatch", (context) => {
    const isNewDraft =
      context.experimental_submission?.pluginId === sandy.pluginId &&
      context.experimental_submission.data !== null &&
      typeof context.experimental_submission.data === "object" &&
      !Array.isArray(context.experimental_submission.data) &&
      context.experimental_submission.data.kind === "draft";
    const firstQueuedMessage = context.queuedMessages[0];
    const isQueuedDraft =
      firstQueuedMessage?.waitingOn?.kind === "plugin" &&
      firstQueuedMessage.waitingOn.pluginId === sandy.pluginId;
    return isNewDraft || isQueuedDraft
      ? { action: "wait", reason: "Draft" }
      : { action: "proceed" };
  });
}

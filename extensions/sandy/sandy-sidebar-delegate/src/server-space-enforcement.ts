import type { MessageDispatchHookContext, MessageDispatchHookDecision } from "@sandy-sdk/plugin-sdk";
import type { ServerContext } from "./server-context";
import type { SpaceRolesService } from "./server-space-roles-service";

function sendersOf(dispatch: MessageDispatchHookContext): string[] {
  if (dispatch.senderThreadId === null) return [];
  if (dispatch.senderThreadId !== "mixed") return [dispatch.senderThreadId];
  const senders = new Set<string>();
  for (const queued of dispatch.queuedMessages) {
    if (queued.senderThreadId !== null) senders.add(queued.senderThreadId);
  }
  return [...senders];
}

function createManagedDispatchDecider(rolesService: SpaceRolesService) {
  return async (dispatch: MessageDispatchHookContext): Promise<MessageDispatchHookDecision> => {
    for (const senderThreadId of sendersOf(dispatch)) {
      const decision = await rolesService.decideManagedTarget(senderThreadId, dispatch.thread.id);
      if (!decision.allowed) return { action: "reject", message: decision.reason };
    }
    return { action: "proceed" };
  };
}

export function registerSpaceEnforcement(ctx: ServerContext, rolesService: SpaceRolesService): void {
  ctx.sandy.experimental_hooks.on("message.dispatch", createManagedDispatchDecider(rolesService));
}

import type { PermissionEscalation } from "@sandy/domain";

export interface InteractiveRequestPolicyInput {
  permissionEscalation: PermissionEscalation | null;
}

export function shouldAutoDenyInteractiveRequest(
  policy: InteractiveRequestPolicyInput,
): boolean {
  return policy.permissionEscalation === "deny";
}

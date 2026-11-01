import { toast as sonner } from "sonner";
import type { ExternalToast } from "sonner";

function themed(options?: ExternalToast): ExternalToast {
  return {
    ...options,
    className: ["sandy-sidebar-toast", options?.className].filter(Boolean).join(" "),
  };
}

// SANDY renders the shimmed Sonner singleton outside the sidebar's DOM tree.
export const toast = {
  success: (...[message, options]: Parameters<typeof sonner.success>) => sonner.success(message, themed(options)),
  error: (...[message, options]: Parameters<typeof sonner.error>) => sonner.error(message, themed(options)),
  message: (...[message, options]: Parameters<typeof sonner.message>) => sonner.message(message, themed(options)),
  dismiss: (id?: string | number) => sonner.dismiss(id),
};

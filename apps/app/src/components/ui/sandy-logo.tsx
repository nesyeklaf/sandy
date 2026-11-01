import { cn } from "@sandy/shared-ui/lib/utils";
import sandyLogoUrl from "../../../../../assets/sandy-logo.svg";

export function SandyLogo({ className = "size-4" }: { className?: string }) {
  return (
    <img
      src={sandyLogoUrl}
      alt=""
      aria-hidden="true"
      className={cn(className, "object-contain")}
    />
  );
}

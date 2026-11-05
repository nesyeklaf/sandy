import { cn } from "@sandy/shared-ui/lib/utils";
import sandyGlyphUrl from "../../../../../assets/sandy-glyph.svg";
import sandyLogoUrl from "../../../../../assets/sandy-logo.svg";

export function SandyLogo({
  className = "size-4",
  glyph = false,
}: {
  className?: string;
  glyph?: boolean;
}) {
  return (
    <img
      src={glyph ? sandyGlyphUrl : sandyLogoUrl}
      alt=""
      aria-hidden="true"
      className={cn(className, "object-contain")}
    />
  );
}

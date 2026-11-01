import { cn } from "@sandy/shared-ui/lib/utils";
import sandyGlyphUrl from "../../../../../assets/sandy-glyph.svg";
import sandyLogoUrl from "../../../../../assets/sandy-logo.svg";

/**
 * The colour mark, or with `glyph` the one-colour version (waves cut out of
 * the disc) for places that recolour it, like `brightness-0 invert`.
 */
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

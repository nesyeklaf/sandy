import type { useProviders } from "./sandy-sdk";
import type { CSSProperties } from "react";

import { cn } from "./lib/utils";
import { TRAILING_GLYPH_BOX_CLASS } from "./StatusSlot";

export type SidebarProvider = ReturnType<typeof useProviders>["providers"][number];

function providerMaskStyle(logoUrl: string): CSSProperties {
  const maskImage = `url(${JSON.stringify(logoUrl)})`;
  return {
    maskImage,
    maskPosition: "center",
    maskRepeat: "no-repeat",
    maskSize: "contain",
    WebkitMaskImage: maskImage,
    WebkitMaskPosition: "center",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskSize: "contain",
  };
}

/**
 * The agent a thread runs on, resolved from sandy's live provider directory.
 *
 * Ends the card's third line or a compact row. A provider without a served
 * logo, or one missing from the current directory, gets a neutral dot.
 */
export function ProviderGlyph({
  providerId,
  provider,
  className,
}: {
  providerId: string;
  provider: SidebarProvider | null;
  className?: string;
}) {
  const box = cn(TRAILING_GLYPH_BOX_CLASS, className);
  const label = provider?.displayName ?? providerId;
  const logoUrl = provider?.logoUrl ?? null;
  const tint = provider?.strings?.iconTint;

  if (logoUrl) {
    const maskStyle = providerMaskStyle(logoUrl);
    return (
      <span role="img" aria-label={label} className={box}>
        {tint ? (
          <>
            <span
              aria-hidden
              className="sandy-sidebar-theme-light-only size-3"
              style={{ ...maskStyle, backgroundColor: tint.light }}
            />
            <span
              aria-hidden
              className="sandy-sidebar-theme-dark-only hidden size-3"
              style={{ ...maskStyle, backgroundColor: tint.dark }}
            />
          </>
        ) : (
          <span aria-hidden className="size-3 bg-muted-foreground/70" style={maskStyle} />
        )}
      </span>
    );
  }

  return (
    <span role="img" aria-label={label} className={box}>
      <span className="size-2 rounded-full bg-muted-foreground/50" />
    </span>
  );
}

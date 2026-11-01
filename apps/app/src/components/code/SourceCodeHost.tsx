import { PluginReplacementSlot } from "@/components/plugin/PluginReplacementSlot";
import { SandySourceCodeSplit } from "./SandySourceCodeSplit";
import { useSourceCodeRendererReplacement } from "./codeRendererProvider";
import {
  DEFAULT_CODE_OVERFLOW,
  type SandySourceCodeProps,
} from "./code-rendering";

const SOURCE_CODE_RENDERER_SLOT_KIND = "sourceCodeRenderer";

interface SourceCodeHostProps extends Omit<
  SandySourceCodeProps,
  "overflow" | "highlightedLines"
> {
  overflow?: SandySourceCodeProps["overflow"];
  highlightedLines?: SandySourceCodeProps["highlightedLines"];
}

export function SourceCodeHost({
  content,
  path,
  cacheKey,
  overflow = DEFAULT_CODE_OVERFLOW,
  highlightedLines = null,
  className,
  scrollToHighlightedLines,
  onSelectionAddToChat,
}: SourceCodeHostProps) {
  const replacement = useSourceCodeRendererReplacement();

  const original = (
    <SandySourceCodeSplit
      content={content}
      path={path}
      cacheKey={cacheKey}
      overflow={overflow}
      highlightedLines={highlightedLines}
      className={className}
      scrollToHighlightedLines={scrollToHighlightedLines}
      onSelectionAddToChat={onSelectionAddToChat}
    />
  );

  return (
    <PluginReplacementSlot
      replacement={replacement}
      original={original}
      slotKind={SOURCE_CODE_RENDERER_SLOT_KIND}
    >
      {(slot, BoundOriginal) => (
        <div className={className}>
          <slot.component
            content={content}
            path={path}
            overflow={overflow}
            highlightedLines={highlightedLines}
            Original={BoundOriginal}
          />
        </div>
      )}
    </PluginReplacementSlot>
  );
}

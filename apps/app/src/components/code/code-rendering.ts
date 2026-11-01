import type {
  CodeOverflowMode,
  DiffViewMode,
  ExperimentalDiffFullFileContents,
  SourceCodeLineRange,
} from "@sandy-sdk/plugin-sdk";
import type { ParsedGitDiffFile } from "@sandy/shared-ui/git-diff/parsing";
import type { DiffPresentation } from "@sandy/shared-ui/git-diff/renderers";

export const DEFAULT_CODE_OVERFLOW: CodeOverflowMode = "scroll";
export const DEFAULT_DIFF_VIEW: DiffViewMode = "unified";

interface SourceCodePresentation {
  overflow: CodeOverflowMode;
  highlightedLines: SourceCodeLineRange | null;
}

export interface SandySourceCodeProps extends SourceCodePresentation {
  content: string;
  path: string;
  cacheKey?: string;
  className?: string;
  scrollToHighlightedLines?: boolean;
  onSelectionAddToChat?: (text: string) => void;
}

export interface SandyDiffProps extends DiffPresentation {
  file: ParsedGitDiffFile;
  patchText?: string;
  fullFileContents: ExperimentalDiffFullFileContents | null;
  className?: string;
  onSelectionAddToChat?: (text: string) => void;
}

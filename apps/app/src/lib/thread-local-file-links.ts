import type { ThreadTimelineLocalFileLink } from "@/components/thread/timeline";
import type { FilePreviewLineRange } from "@sandy/client-core";
import { areHostPathsEqual, getRelativeHostPath } from "@sandy/domain";
import type { WorkspaceOpenTargetId } from "@sandy/host-daemon-contract";
import {
  isAbsoluteFilePathWithinRoot,
  normalizeAbsoluteFilePath,
} from "@sandy/shared-ui/lib/absolute-file-path";
import { isRoutePath } from "./route-paths";

const THREAD_LOCAL_FILE_LINK_UNAVAILABLE_DESCRIPTION =
  "Thread file links are only available when the thread has an environment.";
const THREAD_LOCAL_FILE_LINK_INVALID_PATH_DESCRIPTION =
  "Thread file links must use absolute file paths.";

interface ResolveThreadLocalFileLinkArgs {
  fileOpenTargetIds: readonly WorkspaceOpenTargetId[];
  hostFileLinksAvailable: boolean;
  link: ThreadTimelineLocalFileLink;
  threadStorageRootPath: string | null;
  workspaceRootPath: string | null;
}

interface ThreadWorkspaceFileLinkOpenRequest {
  lineRange: FilePreviewLineRange | null;
  path: string;
  relativePath: string;
  workspaceRootPath: string;
}

interface ThreadHostFileLinkOpenRequest {
  lineRange: FilePreviewLineRange | null;
  path: string;
}

interface ThreadStorageFileLinkOpenRequest {
  lineRange: FilePreviewLineRange | null;
  path: string;
  relativePath: string;
  threadStorageRootPath: string;
}

interface ThreadOpenTargetFileLinkOpenRequest {
  lineRange: FilePreviewLineRange | null;
  path: string;
  targetId: WorkspaceOpenTargetId;
}

interface ThreadLocalFileLinkAppRouteResolution {
  kind: "app-route";
}

interface ThreadLocalFileLinkErrorResolution {
  description: string;
  kind: "error";
}

interface ThreadWorkspaceFileLinkOpenResolution {
  kind: "open-workspace-path";
  request: ThreadWorkspaceFileLinkOpenRequest;
  storageFallback: ThreadStorageFileLinkOpenRequest | null;
}

interface ThreadHostFileLinkOpenResolution {
  kind: "open-host-path";
  request: ThreadHostFileLinkOpenRequest;
}

interface ThreadOpenTargetFileLinkOpenResolution {
  kind: "open-in-target";
  request: ThreadOpenTargetFileLinkOpenRequest;
}

interface ThreadStorageFileLinkOpenResolution {
  kind: "open-thread-storage-path";
  request: ThreadStorageFileLinkOpenRequest;
}

interface NormalizeLocalFilePathWithinRootArgs {
  linkPath: string;
  rootPath: string;
}

interface NormalizedLocalFilePathWithinRoot {
  path: string;
  relativePath: string;
  rootPath: string;
}

export type ThreadLocalFileLinkResolution =
  | ThreadLocalFileLinkAppRouteResolution
  | ThreadLocalFileLinkErrorResolution
  | ThreadWorkspaceFileLinkOpenResolution
  | ThreadHostFileLinkOpenResolution
  | ThreadOpenTargetFileLinkOpenResolution
  | ThreadStorageFileLinkOpenResolution;

function normalizeLocalFilePathWithinRoot(
  args: NormalizeLocalFilePathWithinRootArgs,
): NormalizedLocalFilePathWithinRoot | null {
  const normalizedRootPath = normalizeAbsoluteFilePath({ path: args.rootPath });
  if (!normalizedRootPath) {
    return null;
  }

  const normalizedPath = normalizeAbsoluteFilePath({ path: args.linkPath });
  if (!normalizedPath) {
    return null;
  }

  if (
    !isAbsoluteFilePathWithinRoot({
      candidatePath: normalizedPath,
      rootPath: normalizedRootPath,
    }) ||
    areHostPathsEqual(normalizedPath, normalizedRootPath)
  ) {
    return null;
  }

  const relativePath =
    getRelativeHostPath({
      rootPath: normalizedRootPath,
      candidatePath: normalizedPath,
    }) ?? "";

  return {
    path: normalizedPath,
    relativePath,
    rootPath: normalizedRootPath,
  };
}

const THREAD_STORAGE_VARIABLE_PREFIX = "$SANDY_THREAD_STORAGE/";

interface ResolveStorageRequestForWorkspaceRelativePathArgs {
  lineRange: FilePreviewLineRange | null;
  relativePath: string;
  threadStorageRootPath: string;
}

interface StorageRequestForWorkspaceRelativePath {
  kind: "storage-variable" | "same-relative-path";
  request: ThreadStorageFileLinkOpenRequest;
}

function resolveStorageRequestForWorkspaceRelativePath({
  lineRange,
  relativePath,
  threadStorageRootPath,
}: ResolveStorageRequestForWorkspaceRelativePathArgs): StorageRequestForWorkspaceRelativePath | null {
  const isStorageVariablePath = relativePath.startsWith(
    THREAD_STORAGE_VARIABLE_PREFIX,
  );
  const storageRelativePath = isStorageVariablePath
    ? relativePath.slice(THREAD_STORAGE_VARIABLE_PREFIX.length)
    : relativePath;
  const normalizedRootPath = normalizeAbsoluteFilePath({
    path: threadStorageRootPath,
  });
  if (normalizedRootPath === null) {
    return null;
  }
  const storagePath = normalizeLocalFilePathWithinRoot({
    linkPath: `${normalizedRootPath}/${storageRelativePath}`,
    rootPath: normalizedRootPath,
  });
  if (storagePath === null) {
    return null;
  }
  return {
    kind: isStorageVariablePath ? "storage-variable" : "same-relative-path",
    request: {
      lineRange,
      path: storagePath.path,
      relativePath: storagePath.relativePath,
      threadStorageRootPath: storagePath.rootPath,
    },
  };
}

export function resolveThreadLocalFileLink(
  args: ResolveThreadLocalFileLinkArgs,
): ThreadLocalFileLinkResolution {
  if (isRoutePath({ path: args.link.path })) {
    return {
      kind: "app-route",
    };
  }

  const normalizedPath = normalizeAbsoluteFilePath({ path: args.link.path });
  if (!normalizedPath) {
    return {
      description: THREAD_LOCAL_FILE_LINK_INVALID_PATH_DESCRIPTION,
      kind: "error",
    };
  }

  const openTargetId = args.link.openTargetId;
  if (openTargetId !== null && args.fileOpenTargetIds.includes(openTargetId)) {
    return {
      kind: "open-in-target",
      request: {
        lineRange: args.link.lineRange,
        path: normalizedPath,
        targetId: openTargetId,
      },
    };
  }

  const openRequest =
    args.workspaceRootPath === null
      ? null
      : normalizeLocalFilePathWithinRoot({
          linkPath: normalizedPath,
          rootPath: args.workspaceRootPath,
        });

  if (openRequest) {
    const storageRequest =
      args.threadStorageRootPath === null
        ? null
        : resolveStorageRequestForWorkspaceRelativePath({
            lineRange: args.link.lineRange,
            relativePath: openRequest.relativePath,
            threadStorageRootPath: args.threadStorageRootPath,
          });
    if (storageRequest?.kind === "storage-variable") {
      return {
        kind: "open-thread-storage-path",
        request: storageRequest.request,
      };
    }
    return {
      kind: "open-workspace-path",
      request: {
        lineRange: args.link.lineRange,
        path: openRequest.path,
        relativePath: openRequest.relativePath,
        workspaceRootPath: openRequest.rootPath,
      },
      storageFallback: storageRequest?.request ?? null,
    };
  }

  const storageOpenRequest =
    args.threadStorageRootPath === null
      ? null
      : normalizeLocalFilePathWithinRoot({
          linkPath: normalizedPath,
          rootPath: args.threadStorageRootPath,
        });

  if (storageOpenRequest) {
    return {
      kind: "open-thread-storage-path",
      request: {
        lineRange: args.link.lineRange,
        path: storageOpenRequest.path,
        relativePath: storageOpenRequest.relativePath,
        threadStorageRootPath: storageOpenRequest.rootPath,
      },
    };
  }

  if (!args.hostFileLinksAvailable) {
    return {
      description: THREAD_LOCAL_FILE_LINK_UNAVAILABLE_DESCRIPTION,
      kind: "error",
    };
  }

  return {
    kind: "open-host-path",
    request: {
      lineRange: args.link.lineRange,
      path: normalizedPath,
    },
  };
}

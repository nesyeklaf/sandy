import { joinHostPathSegments } from "../services/lib/host-path.js";
import { serverAccess } from "../services/machines/server-access.js";
import {
  getLatestSessionForHost,
  getNonDestroyedHost,
  getPublicProjectByLocalPathSource,
  updateHost,
} from "@sandy/db";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@sandy/server-contract";
import type { Hono } from "hono";
import { HOST_DAEMON_PROTOCOL_VERSION } from "@sandy/host-daemon-contract";
import type { AppDeps } from "../types.js";
import { getProviderInstallations } from "../services/system/provider-installations.js";
import { COMMAND_TIMEOUT_MS } from "../constants.js";
import { ApiError } from "../errors.js";
import {
  listPublicHostsWithStatus,
  requireNonDestroyedHostWithStatus,
  requirePublicStandardProject,
} from "../services/lib/entity-lookup.js";
import {
  assertUsableHostId,
  isServerMachineHost,
  resolvePrimaryHostId,
} from "../services/hosts/primary-host.js";
import { issueHostEnrollKey } from "../services/hosts/host-enrollment.js";
import {
  callHostOnlineRpcForWork,
  callHostRetryableOnlineRpc,
} from "../services/hosts/online-rpc.js";
import {
  handleHostRemoved,
  settleRemovedHostWork,
} from "../internal/session-owner-side-effects.js";
import {
  submitMachine,
  requestMachineRemoval,
  startMachineResume,
  startMachineSuspension,
  startMachineReconciliation,
  forceMachineRemoval,
  retryMachineCleanup,
  sweepProviderMachine,
} from "../services/machines/provider-orchestration.js";
import { getMachineEnrollmentService } from "../services/machines/machine-services.js";
import { manualHostCommand } from "../services/machines/manual-provider.js";
import { prepareReconnect } from "../services/machines/reconnect.js";
import { emitPluginHostDeleted } from "../services/plugins/plugin-thread-events.js";

const DISCOVERED_REPOS_MAX_DEPTH = 5;
const DISCOVERED_REPOS_SINCE_DAYS = 30;
const DISCOVERED_REPOS_LIMIT = 10;

const FOLDER_PICKER_TIMEOUT_MS = 10 * 60 * 1000;

function requireMutableHost(deps: AppDeps, hostId: string) {
  const host = getNonDestroyedHost(deps.db, hostId);
  if (!host) {
    throw new ApiError(404, "host_not_found", "Host not found");
  }
  return host;
}

function assertNotServerMachine(deps: AppDeps, hostId: string): void {
  if (isServerMachineHost(deps, hostId)) {
    throw new ApiError(
      400,
      "server_host_lifecycle_refused",
      "The server machine can't be suspended or resumed. Move the server to another machine first.",
    );
  }
}

export function registerHostRoutes(
  app: Hono,
  deps: AppDeps,
): void {
  const { del, get, patch, post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  const routes = publicApiRoutes.hosts;

  post(routes.create, async (context, payload) => {
    return context.json(await submitMachine(deps, payload), 201);
  });

  post(routes.createJoinCode, async (context) => {
    const issued = await issueHostEnrollKey(deps, {
      enrollSource: "public-multi-machine",
    });
    return context.json(
      {
        joinCode: issued.enrollKey.key,
        hostId: issued.hostId,
        expiresAt: issued.enrollKey.expiresAt,
      },
      201,
    );
  });

  get(routes.list, (context, query) =>
    context.json(
      listPublicHostsWithStatus(deps, {
        includeCreating: query.includeCreating === "true",
        type: query.type,
      }),
    ),
  );

  get(routes.get, (context) => {
    const hostId = context.req.param("id");
    const host = requireNonDestroyedHostWithStatus(deps, hostId);
    const session = getLatestSessionForHost(deps.db, { hostId });
    return context.json({
      ...host,
      connectMachineId: requireMutableHost(deps, hostId).connectMachineId,
      threadStorageRootPath:
        session === null
          ? null
          : joinHostPathSegments(session.dataDir, "thread-storage"),
    });
  });

  get(routes.enrollmentCommand, async (context) => {
    requireMutableHost(deps, context.req.param("id"));
    return context.json(
      await manualHostCommand(
        getMachineEnrollmentService(deps),
        context.req.param("id"),
      ),
    );
  });

  post(routes.reconnect, async (context) => {
    const hostId = context.req.param("id");
    const host = requireMutableHost(deps, hostId);
    if (resolvePrimaryHostId(deps) === hostId || host.phase !== "active")
      throw new ApiError(
        409,
        "machine_reconnect_unavailable",
        "Only active machines other than the server's own can be reconnected",
      );
    if (deps.hub.hasDaemonForHost(hostId))
      throw new ApiError(
        409,
        "machine_reconnect_not_needed",
        "Machine is connected and doesn't need reconnecting",
      );
    return context.json(await prepareReconnect(deps, hostId), 201);
  });

  patch(routes.update, (context, payload) => {
    const hostId = context.req.param("id");
    requireMutableHost(deps, hostId);
    const updated = updateHost(deps.db, deps.hub, hostId, {
      name: payload.name,
    });
    if (!updated) {
      throw new ApiError(404, "host_not_found", "Host not found");
    }
    deps.hub.notifyHost(hostId, ["host-connected"]);
    return context.json(requireNonDestroyedHostWithStatus(deps, updated.id));
  });

  patch(routes.updatePermissionCeiling, (context, payload) => {
    const hostId = context.req.param("id");
    requireMutableHost(deps, hostId);
    const updated = updateHost(deps.db, deps.hub, hostId, {
      maxPermissionMode: payload.maxPermissionMode,
    });
    if (!updated) {
      throw new ApiError(404, "host_not_found", "Host not found");
    }
    deps.hub.notifyHost(hostId, ["host-connected"]);
    return context.json(requireNonDestroyedHostWithStatus(deps, updated.id));
  });

  post(routes.retryUpdate, (context) => {
    const hostId = context.req.param("id");
    const host = requireMutableHost(deps, hostId);
    if (host.lastRejectedProtocolVersion === null) {
      throw new ApiError(
        409,
        "host_update_not_needed",
        "The machine is not waiting for a protocol update",
      );
    }
    if (host.lastRejectedProtocolVersion >= HOST_DAEMON_PROTOCOL_VERSION) {
      throw new ApiError(
        409,
        "host_cannot_self_update",
        "The machine daemon is not older than this server",
      );
    }
    deps.hub.requestHostProtocolUpdateRetry(hostId);
    return context.json({ ok: true as const });
  });

  post(routes.reconcile, (context) => {
    const hostId = context.req.param("id");
    startMachineReconciliation(deps, hostId);
    return context.json(requireNonDestroyedHostWithStatus(deps, hostId), 202);
  });

  post(routes.suspend, (context) => {
    const hostId = context.req.param("id");
    assertNotServerMachine(deps, hostId);
    startMachineSuspension(deps, hostId);
    return context.json(requireNonDestroyedHostWithStatus(deps, hostId), 202);
  });

  post(routes.resume, (context) => {
    const hostId = context.req.param("id");
    assertNotServerMachine(deps, hostId);
    startMachineResume(deps, hostId);
    return context.json(requireNonDestroyedHostWithStatus(deps, hostId), 202);
  });

  post(routes.retryCleanup, async (context) => {
    await retryMachineCleanup(deps, context.req.param("id"));
    return context.json({ ok: true as const });
  });

  del(routes.delete, async (context, query) => {
    const hostId = context.req.param("id");
    if (query.force === "true") {
      await forceMachineRemoval(deps, hostId);
      return context.json({ ok: true as const });
    }
    const host = requireMutableHost(deps, hostId);
    if (resolvePrimaryHostId(deps) === hostId) {
      throw new ApiError(
        400,
        "primary_host_removal_refused",
        "The primary host cannot be removed",
      );
    }

    if (host.machineProviderId !== null) {
      requestMachineRemoval(deps, hostId);
      settleRemovedHostWork(deps, { hostId });
      await sweepProviderMachine(deps, hostId);
      return context.json({ ok: true });
    }

    await serverAccess.release(deps, { key: hostId, hostId });
    await deps.machineAuth.revokeHostAuthKeys({
      hostId,
    });
    const sessionId = deps.hub.getDaemonSessionIdForHost(hostId);
    if (sessionId) {
      handleHostRemoved(deps, { hostId, sessionId });
    }
    settleRemovedHostWork(deps, { hostId });
    const destroyed = updateHost(deps.db, deps.hub, hostId, {
      destroyedAt: Date.now(),
    });
    deps.lifecycleDedupers.providerModelCatalogs.forgetHost(deps, hostId);
    if (destroyed !== null) emitPluginHostDeleted(destroyed);
    return context.json({ ok: true });
  });

  get(routes.discoveredRepos, async (context) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.discover_repos",
        maxDepth: DISCOVERED_REPOS_MAX_DEPTH,
        sinceDays: DISCOVERED_REPOS_SINCE_DAYS,
        limit: DISCOVERED_REPOS_LIMIT,
      },
    });
    return context.json({
      repos: result.repos.map((repo) => ({
        ...repo,
        projectId:
          getPublicProjectByLocalPathSource(deps.db, {
            type: "local_path",
            hostId,
            path: repo.path,
          })?.id ?? null,
      })),
      truncated: result.truncated,
    });
  });

  get(routes.directory, async (context, query) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.browse_directory",
        ...(query.path ? { path: query.path } : {}),
      },
    });
    return context.json(result);
  });

  get(routes.cloneDefaultPath, async (context, query) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const project = requirePublicStandardProject(deps.db, query.projectId);
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "project.clone_default_path",
        projectSlug: project.name,
      },
    });
    return context.json(result);
  });

  post(routes.pathsExist, async (context, payload) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const result = await callHostRetryableOnlineRpc(deps, {
      hostId,
      timeoutMs: COMMAND_TIMEOUT_MS,
      command: {
        type: "host.paths_exist",
        paths: payload.paths,
      },
    });
    return context.json(result);
  });

  post(routes.pickFolder, async (context, payload) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    if (payload.clientHostId !== hostId) {
      throw new ApiError(
        409,
        "native_picker_unavailable",
        "Native folder picker is only available when the browser helper and work host are on the same machine",
      );
    }
    const result = await callHostOnlineRpcForWork(deps, {
      hostId,
      timeoutMs: FOLDER_PICKER_TIMEOUT_MS,
      command: {
        type: "host.pick_folder",
      },
    });
    return context.json(result);
  });

  get(routes.providerCliStatus, async (context) => {
    const hostId = context.req.param("id");
    assertUsableHostId(deps, { hostId });
    const result = await getProviderInstallations(deps, { hostId });
    return context.json(result);
  });
}

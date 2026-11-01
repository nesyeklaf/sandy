import { randomUUID } from "node:crypto";
import {
  PluginCliError,
  cliCommand,
  defineCli,
  type SandyPluginApi,
} from "@sandy-sdk/plugin-sdk";
import {
  CLIENT_NOTIFICATION_CHANNEL,
  clientChannelSchema,
  NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_TITLE_MAX_LENGTH,
  pushNotificationsRpcContract,
  sendNotificationInputSchema,
  sendNotificationRpcContract,
  type ClientNotification,
  type DeliveryChannel,
} from "./contract.js";
import {
  createNotificationPreferences,
  describeNotificationSource,
  NOTIFICATION_LEVEL_LABELS,
  notificationLevelSchema,
  ownNotificationLevelSchema,
  type ThreadNotifications,
} from "./preferences.js";
import {
  createPushSender,
  SendNotificationError,
} from "./sender.js";

interface PushNotificationsPluginOptions {
  coalesceMs?: number;
  now?: () => number;
}

interface StatusView {
  enabled: true;
  webEnabled: boolean;
  desktopEnabled: boolean;
  defaultLevel: string;
  childLevel: string;
}

const JSON_OPTION = {
  type: "boolean",
  description: "Emit machine-readable JSON",
} as const;

function formatStatus(status: StatusView): string {
  return [
    `Enabled: ${status.enabled}`,
    `Web: ${status.webEnabled}`,
    `Desktop: ${status.desktopEnabled}`,
    `Default level: ${status.defaultLevel}`,
    `Child thread level: ${status.childLevel}`,
  ].join("\n");
}

function formatThreadNotifications(
  threadId: string,
  row: ThreadNotifications,
): string {
  return `Notifications for ${threadId}: ${row.effective} (${describeNotificationSource(row)})`;
}

function formatSent(channels: readonly DeliveryChannel[]): string {
  return `Sent to ${channels.join(", ")}`;
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export function createPushNotificationsPlugin(
  options: PushNotificationsPluginOptions = {},
) {
  return async function pushNotificationsPlugin(
    sandy: SandyPluginApi,
  ): Promise<void> {
    const settings = sandy.settings.define({
      webEnabled: {
        type: "boolean",
        label: "Web notifications",
        description:
          "Show system notifications while sandy is open in a browser. Each browser needs notification permission.",
        default: true,
      },
      desktopEnabled: {
        type: "boolean",
        label: "Desktop notifications",
        description:
          "Show system notifications while the sandy desktop app is running.",
        default: true,
      },
      defaultLevel: {
        type: "select",
        label: "Default notifications",
        description:
          "For threads you haven't set. Needs input only skips finished turns.",
        options: [...notificationLevelSchema.options],
        experimental_optionLabels: {
          all: NOTIFICATION_LEVEL_LABELS.all,
          "input-only": NOTIFICATION_LEVEL_LABELS["input-only"],
          muted: NOTIFICATION_LEVEL_LABELS.muted,
        },
        default: "all",
        experimental_schema: notificationLevelSchema,
      },
      childLevel: {
        type: "select",
        label: "Child thread notifications",
        description:
          "For child threads you haven't set. A thread's level also limits its child threads.",
        options: [...ownNotificationLevelSchema.options],
        experimental_optionLabels: {
          inherit: NOTIFICATION_LEVEL_LABELS.inherit,
          all: NOTIFICATION_LEVEL_LABELS.all,
          "input-only": NOTIFICATION_LEVEL_LABELS["input-only"],
          muted: NOTIFICATION_LEVEL_LABELS.muted,
        },
        default: "input-only",
        experimental_schema: ownNotificationLevelSchema,
      },
    });
    const preferences = createNotificationPreferences({
      sandy,
      getDefaults: async () => {
        const { defaultLevel, childLevel } = await settings.get();
        return {
          defaultLevel: notificationLevelSchema.parse(defaultLevel),
          childLevel: ownNotificationLevelSchema.parse(childLevel),
        };
      },
      publish: (threadIds) =>
        sandy.rpc.experimental_invalidate(threadIds.map((id) => `thread:${id}`)),
    });
    const sender = createPushSender({
      sandy,
      getDeliverySettings: () => settings.get(),
      getNotificationLevel: (thread) => preferences.effectiveLevel(thread),
      ...(options.coalesceMs === undefined
        ? {}
        : { coalesceMs: options.coalesceMs }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });

    async function status(): Promise<StatusView> {
      const { webEnabled, desktopEnabled, defaultLevel, childLevel } =
        await settings.get();
      return {
        enabled: true,
        webEnabled,
        desktopEnabled,
        defaultLevel,
        childLevel,
      };
    }

    async function sendTest(channel: "web" | "desktop") {
      const config = await settings.get();
      if (!(channel === "web" ? config.webEnabled : config.desktopEnabled)) {
        throw new Error(`${channel} notifications are disabled`);
      }
      sandy.realtime.publish(CLIENT_NOTIFICATION_CHANNEL, {
        id: randomUUID(),
        title: "sandy notifications are working",
        body: "You’ll be notified when a thread needs your attention.",
        threadId: null,
        channels: [channel],
      } satisfies ClientNotification);
      return { ok: true as const };
    }

    sandy.rpc.register(
      sendNotificationRpcContract,
      {
        "notifications.send": async (input, context) => ({
          ok: true as const,
          channels: await sender.send(input, context.experimental_caller),
        }),
      },
      {
        experimental_discoverable: true,
        experimental_description:
          "Notifications on sandy's web and desktop channels.",
      },
    );

    sandy.rpc.register(pushNotificationsRpcContract, {
      "notifications.test": ({ channel }) => sendTest(channel),
      "threadNotifications.keyed": async ({ keys }) => {
        const rows = await preferences.list(keys);
        return Object.fromEntries(
          keys.map((key) => [
            key,
            rows[key] ?? { own: "inherit" as const, ancestorCap: null },
          ]),
        );
      },
      "threadNotifications.list": async ({ threadIds }) => ({
        threads: await preferences.list(threadIds),
      }),
      "threadNotifications.set": ({ threadId, level }) =>
        preferences.set(threadId, level),
    });

    sandy.cli.register(
      defineCli({
        name: "push-notifications",
        summary: "Manage web and desktop notifications",
        description:
          "Web and desktop clients receive system notifications while they are open.",
        commands: {
          test: cliCommand({
            summary:
              "Send a test to connected web or desktop clients with permission",
            positionals: [
              {
                name: "channel",
                description: "Client type to notify: web or desktop",
                required: true,
              },
            ],
            options: { json: JSON_OPTION },
            async run(input) {
              const channel = clientChannelSchema.safeParse(
                input.positionals.channel,
              );
              if (!channel.success) {
                throw new PluginCliError("Use web or desktop", {
                  code: "invalid_channel",
                });
              }
              try {
                await sendTest(channel.data);
              } catch (error) {
                throw new PluginCliError(
                  error instanceof Error ? error.message : String(error),
                  {
                    code: "channel_disabled",
                    hint: `Turn it on with \`sandy plugin config push-notifications set ${channel.data}Enabled true\`.`,
                  },
                );
              }
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ ok: true, channel: channel.data })
                  : `Test sent to connected ${channel.data} clients with notification permission`,
              };
            },
          }),
          send: cliCommand({
            summary: "Send a notification to every enabled channel",
            description: `Uses the same delivery as thread notifications: connected web and desktop clients with permission. The title is cut to ${NOTIFICATION_TITLE_MAX_LENGTH} characters and the body to ${NOTIFICATION_BODY_MAX_LENGTH}. With --thread, a click opens that thread; otherwise it opens sandy.`,
            options: {
              title: {
                type: "string",
                required: true,
                placeholder: "text",
                description: "Notification title",
              },
              body: {
                type: "string",
                placeholder: "text",
                description: "Notification text under the title",
              },
              thread: {
                type: "string",
                placeholder: "thread-id",
                description: "Thread to open when the notification is clicked",
              },
              json: JSON_OPTION,
            },
            async run(input) {
              const parsed = sendNotificationInputSchema.safeParse({
                title: input.options.title,
                ...(input.options.body === undefined
                  ? {}
                  : { body: input.options.body }),
                ...(input.options.thread === undefined
                  ? {}
                  : { threadId: input.options.thread }),
              });
              if (!parsed.success) {
                throw new PluginCliError(
                  parsed.error.issues
                    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                    .join("; "),
                  { code: "invalid_notification" },
                );
              }
              let channels: DeliveryChannel[];
              try {
                channels = await sender.send(parsed.data, { kind: "client" });
              } catch (error) {
                if (!(error instanceof SendNotificationError)) throw error;
                throw new PluginCliError(
                  error.message,
                  error.code === "thread_not_found"
                    ? { code: error.code }
                    : {
                        code: error.code,
                        hint: "Check the push-sender service in `sandy plugin list`.",
                      },
                );
              }
              if (channels.length === 0) {
                throw new PluginCliError(
                  "No channel received the notification",
                  {
                    code: "not_delivered",
                    hint: "Run `sandy push-notifications status` to see which channels are on.",
                  },
                );
              }
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ ok: true, channels })
                  : formatSent(channels),
              };
            },
          }),
          thread: cliCommand({
            summary: "Show or set a thread's notification level",
            description:
              "Without --level, prints the resolved level and where it comes from. A thread uses its own level, else childLevel if it has a parent, else defaultLevel; every ancestor's own level caps it.",
            positionals: [
              {
                name: "thread",
                description: "Thread id",
                required: true,
              },
            ],
            options: {
              level: {
                type: "enum",
                values: ownNotificationLevelSchema.options,
                description:
                  "Set the thread's own level; inherit clears it so the parent or default applies",
              },
              json: JSON_OPTION,
            },
            async run(input) {
              const threadId = input.positionals.thread;
              let row: ThreadNotifications;
              try {
                if (input.options.level !== undefined) {
                  await preferences.set(threadId, input.options.level);
                }
                row = await preferences.get(threadId);
              } catch (error) {
                throw new PluginCliError(
                  error instanceof Error ? error.message : String(error),
                  { code: "thread_not_found" },
                );
              }
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify({ threadId, ...row })
                  : formatThreadNotifications(threadId, row),
              };
            },
          }),
          status: cliCommand({
            summary: "Show push delivery status",
            options: { json: JSON_OPTION },
            async run(input) {
              const view = await status();
              return {
                exitCode: 0,
                stdout: input.options.json
                  ? JSON.stringify(view)
                  : formatStatus(view),
              };
            },
          }),
        },
      }),
    );

    sandy.events.on("interaction.pending", (payload) => {
      sender.onInteractionPending(payload);
    });
    sandy.events.on("thread.idle", (payload) => {
      sender.onThreadIdle(payload);
    });
    sandy.events.on("thread.failed", (payload) => {
      sender.onThreadFailed(payload);
    });
    sandy.events.on("experimental_thread.parentChanged", ({ thread }) =>
      preferences.publishSubtree(thread.id),
    );
    sandy.events.on("thread.unarchived", ({ thread }) =>
      preferences.publishSubtree(thread.id),
    );
    sandy.background.service("push-sender", {
      async start(signal) {
        sender.start();
        try {
          await waitForAbort(signal);
        } finally {
          await sender.stop();
        }
      },
    });
  };
}

export default createPushNotificationsPlugin();

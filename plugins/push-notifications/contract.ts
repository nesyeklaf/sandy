import { defineRpcContract } from "@sandy-sdk/plugin-sdk";
import { z } from "zod";
import {
  ownNotificationLevelSchema,
  threadNotificationInputsSchema,
} from "./preferences.js";

export const clientChannelSchema = z.enum(["web", "desktop"]);
export const CLIENT_NOTIFICATION_CHANNEL = "notification";
export const clientNotificationSchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    body: z.string(),
    threadId: z.string().nullable(),
    channels: z.array(clientChannelSchema),
  })
  .strict();
export type ClientNotification = z.infer<typeof clientNotificationSchema>;

export const NOTIFICATION_TITLE_MAX_LENGTH = 80;
export const NOTIFICATION_BODY_MAX_LENGTH = 180;
export const SEND_TEXT_MAX_LENGTH = 4_000;
export type DeliveryChannel = z.infer<typeof clientChannelSchema>;
export const sendNotificationInputSchema = z
  .object({
    title: z.string().trim().min(1).max(SEND_TEXT_MAX_LENGTH),
    body: z.string().trim().max(SEND_TEXT_MAX_LENGTH).default(""),
    threadId: z.string().trim().min(1).optional(),
  })
  .strict();
export const sendNotificationOutputSchema = z
  .object({
    ok: z.literal(true),
    channels: z.array(clientChannelSchema),
  })
  .strict();
export type SendNotificationInput = z.infer<typeof sendNotificationInputSchema>;
export type SendNotificationOutput = z.infer<
  typeof sendNotificationOutputSchema
>;

export const sendNotificationRpcContract = defineRpcContract({
  "notifications.send": {
    experimental_description:
      "Send a notification to every enabled channel: connected web and desktop clients. Title and body are cut to 80 and 180 characters. With threadId, a click opens that thread. Returns the channels it reached; an empty list means nothing was delivered.",
    input: sendNotificationInputSchema,
    output: sendNotificationOutputSchema,
  },
});

export const THREAD_NOTIFICATIONS_LIST_MAX_IDS = 200;

export const pushNotificationsRpcContract = defineRpcContract({
  "notifications.test": {
    input: z.object({ channel: clientChannelSchema }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
  "threadNotifications.list": {
    input: z
      .object({
        threadIds: z
          .array(z.string().min(1))
          .min(1)
          .max(THREAD_NOTIFICATIONS_LIST_MAX_IDS),
      })
      .strict(),
    output: z
      .object({
        threads: z.record(z.string(), threadNotificationInputsSchema),
      })
      .strict(),
  },
  "threadNotifications.keyed": {
    input: z
      .object({
        keys: z
          .array(z.string().min(1))
          .min(1)
          .max(THREAD_NOTIFICATIONS_LIST_MAX_IDS),
      })
      .strict(),
    output: z.record(z.string(), threadNotificationInputsSchema),
    keyTags: (key) => [`thread:${key}`],
  },
  "threadNotifications.set": {
    input: z
      .object({
        threadId: z.string().min(1),
        level: ownNotificationLevelSchema,
      })
      .strict(),
    output: threadNotificationInputsSchema,
  },
});

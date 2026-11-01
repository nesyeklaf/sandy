import { createHmac, timingSafeEqual } from "node:crypto";
import type { SandyPluginApi } from "@sandy-sdk/plugin-sdk";

const SIGNATURE_VERSION = "v0";
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

const CONFIGURE_HINT =
  "Set botToken, signingSecret, and project with `sandy plugin config slack-bot`, " +
  "then `sandy plugin reload slack-bot`.";

function verifySlackSignature(args: {
  signingSecret: string;
  timestamp: string;
  signature: string;
  rawBody: string;
}): boolean {
  const timestamp = Number(args.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - timestamp) > SIGNATURE_MAX_AGE_SECONDS) {
    return false;
  }
  const expected =
    `${SIGNATURE_VERSION}=` +
    createHmac("sha256", args.signingSecret)
      .update(`${SIGNATURE_VERSION}:${args.timestamp}:${args.rawBody}`)
      .digest("hex");
  const expectedBuffer = Buffer.from(expected, "utf8");
  const presentedBuffer = Buffer.from(args.signature, "utf8");
  return (
    expectedBuffer.length === presentedBuffer.length &&
    timingSafeEqual(expectedBuffer, presentedBuffer)
  );
}

function stripMentions(text: string): string {
  return text.replace(/<@[^>]+>/g, "").trim();
}

interface SlackTarget {
  channel: string;
  threadTs: string;
}

export default async function plugin(sandy: SandyPluginApi) {
  const settings = sandy.settings.define({
    botToken: {
      type: "string",
      label: "Slack bot token (xoxb-...)",
      description: "OAuth bot token with chat:write; used to post replies.",
      secret: true,
    },
    signingSecret: {
      type: "string",
      label: "Slack signing secret",
      description: "Verifies that webhook events really come from Slack.",
      secret: true,
    },
    channelId: {
      type: "string",
      label: "Announcement channel ID",
      description:
        "Optional channel for bot notices; replies always go to the mention's thread.",
    },
    project: {
      type: "project",
      label: "SANDY project for mention threads",
      description: "Mentions spawn SANDY threads in this project.",
    },
  });

  const initial = await settings.get();
  if (!initial.botToken || !initial.signingSecret || !initial.project) {
    sandy.status.needsConfiguration(CONFIGURE_HINT);
  }

  sandy.http.route(
    "POST",
    "/events",
    async (context) => {
      const current = await settings.get();
      if (!current.signingSecret) {
        return context.json(
          {
            ok: false,
            error: `slack-bot is not configured. ${CONFIGURE_HINT}`,
          },
          503,
        );
      }
      const rawBody = await context.req.text();
      const verified = verifySlackSignature({
        signingSecret: current.signingSecret,
        timestamp: context.req.header("x-slack-request-timestamp") ?? "",
        signature: context.req.header("x-slack-signature") ?? "",
        rawBody,
      });
      if (!verified) {
        return context.json(
          { ok: false, error: "invalid Slack signature" },
          401,
        );
      }

      let body: any;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return context.json({ ok: false, error: "body must be JSON" }, 400);
      }

      if (body?.type === "url_verification") {
        return context.json({ challenge: body.challenge });
      }

      if (
        body?.type === "event_callback" &&
        body.event?.type === "app_mention"
      ) {
        const event = body.event as {
          channel: string;
          text: string;
          ts: string;
          thread_ts?: string;
        };
        if (!current.project) {
          sandy.log.warn(
            `mention ignored — no project configured. ${CONFIGURE_HINT}`,
          );
          return context.json({ ok: true });
        }
        const prompt = stripMentions(event.text);
        const threadTs = event.thread_ts ?? event.ts;

        const existing = await sandy.storage.kv.get<string>(`slack:${threadTs}`);
        if (existing !== undefined) {
          await sandy.sdk.threads.send({
            threadId: existing,
            mode: "auto",
            input: [{ type: "text", text: prompt }],
          });
          return context.json({ ok: true });
        }

        const thread = await sandy.sdk.threads.spawn({
          projectId: current.project,
          prompt,
          environment: { type: "project-default" },
          title: `Slack: ${prompt.slice(0, 60) || "mention"}`,
        });
        await sandy.storage.kv.set(`slack:${threadTs}`, thread.id);
        await sandy.storage.kv.set(`sandy:${thread.id}`, {
          channel: event.channel,
          threadTs,
        } satisfies SlackTarget);
        sandy.log.info(`mention in ${event.channel} → thread ${thread.id}`);
        return context.json({ ok: true });
      }

      return context.json({ ok: true });
    },
    { auth: "none" },
  );

  sandy.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const target = await sandy.storage.kv.get<SlackTarget>(`sandy:${thread.id}`);
    if (target === undefined || lastAssistantText === null) return;
    const { botToken } = await settings.get();
    if (!botToken) {
      sandy.status.needsConfiguration(CONFIGURE_HINT);
      return;
    }
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        authorization: `Bearer ${botToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        channel: target.channel,
        thread_ts: target.threadTs,
        text: lastAssistantText,
      }),
    });
    const result = (await response.json()) as { ok: boolean; error?: string };
    if (!result.ok) {
      sandy.log.warn(
        `chat.postMessage failed: ${result.error ?? "unknown error"}`,
      );
    }
  });
}

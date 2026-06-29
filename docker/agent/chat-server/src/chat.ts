/**
 * chat.ts — Chat SDK setup and unified message handler.
 *
 * All message sources (Telegram webhook, HTTP chat) flow through Chat SDK's
 * event pipeline: onNewMention / onSubscribedMessage → runAgentTurn() → thread.post().
 *
 * Adding a new source = adding an adapter + a webhook route.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as http from "node:http";
import * as crypto from "node:crypto";
import { Chat, type Message, type MessageContext, type Thread, type Adapter, type Author } from "chat";
import { createTelegramAdapter } from "@chat-adapter/telegram";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
import { createTeamsAdapter } from "@chat-adapter/teams";
import { createMemoryState } from "@chat-adapter/state-memory";
import { runAgentTurn, AT_CAPACITY, renderAtCapacityReply, type TurnSource, type TurnResult } from "./agent.js";
import { platformClient } from "./platform-client.js";
import { commonMarkToTelegramMarkdown } from "./telegram-markdown.js";
import { rootLogger, logCatch } from "./logger.js";

const CONFIG_DIR = process.env.CONFIG_DIR || "/config";

// ---------------------------------------------------------------------------
// Member lookup — via Agent Platform API (cached). Failures fall back to
// "no members" so an outage rejects rather than admits unknown users.
// ---------------------------------------------------------------------------

async function isTelegramMember(telegramUserId: string): Promise<boolean> {
  try {
    const members = await platformClient.getMembers();
    return members.some((m) => m.telegramUserId === telegramUserId);
  } catch (err) {
    logCatch(rootLogger, "chat.member.telegram_lookup_failed", err, { telegramUserId });
    return false;
  }
}

async function isCognitoMember(userId: string): Promise<boolean> {
  try {
    const members = await platformClient.getMembers();
    return members.some((m) => m.userId === userId);
  } catch (err) {
    logCatch(rootLogger, "chat.member.cognito_lookup_failed", err, { userId });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Telegram "admin in group" check.
//
// Rule: a non-member who messages the bot from a Telegram group is allowed
// through iff the workspace admin (a member with role=admin who has linked
// a telegramUserId) is also present in that group. The reasoning: the
// admin's presence transitively vets everyone else in the group, the same
// way Slack workspace admission vets every Slack user.
//
// Implementation: one `getChatMember` call per admin per group (usually one
// admin per workspace, so one call). Result is cached per-chat for 5 min
// to keep chatty groups cheap. On any API failure, fail-closed (reject) —
// a false negative is a member can't talk for ~5 minutes, vs a false
// positive that lets a stranger into the workspace.
// ---------------------------------------------------------------------------

const ADMIN_GROUP_CACHE_TTL_MS = 5 * 60 * 1000;
const adminInGroupCache = new Map<string, { present: boolean; expiresAt: number }>();

const TELEGRAM_PRESENT_STATUSES = new Set(["member", "administrator", "creator"]);

async function isAdminInTelegramGroup(chatId: string): Promise<boolean> {
  const now = Date.now();
  const cached = adminInGroupCache.get(chatId);
  if (cached && cached.expiresAt > now) {
    return cached.present;
  }

  const botToken = currentTelegramToken;
  if (!botToken) {
    // Telegram adapter not initialized yet — nothing we can do.
    return false;
  }

  let present = false;
  try {
    const members = await platformClient.getMembers();
    const adminTgIds = members
      .filter((m) => m.role === "admin" && m.telegramUserId)
      .map((m) => m.telegramUserId as string);

    for (const adminId of adminTgIds) {
      try {
        const resp = await fetch(
          `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(
            chatId,
          )}&user_id=${encodeURIComponent(adminId)}`,
        );
        const data = (await resp.json()) as {
          ok?: boolean;
          result?: { status?: string };
        };
        if (
          data.ok &&
          data.result &&
          TELEGRAM_PRESENT_STATUSES.has(data.result.status ?? "")
        ) {
          present = true;
          break;
        }
      } catch (err) {
        logCatch(rootLogger, "chat.telegram.get_chat_member_failed", err, {
          chatId,
          adminTelegramId: adminId,
        });
        // Try the next admin; an isolated API failure shouldn't lock the
        // whole group out if a second admin can satisfy the check.
      }
    }
  } catch (err) {
    logCatch(rootLogger, "chat.telegram.admin_lookup_failed", err, { chatId });
  }

  adminInGroupCache.set(chatId, {
    present,
    expiresAt: now + ADMIN_GROUP_CACHE_TTL_MS,
  });
  return present;
}

// ---------------------------------------------------------------------------
// Chat SDK instance
// ---------------------------------------------------------------------------

let chat: Chat<Record<string, Adapter>> | null = null;
let currentAdapters: Record<string, Adapter> = {};
let currentSecretsHash = "";
let currentTelegramToken = "";

export function getChatInstance(): Chat<Record<string, Adapter>> | null {
  return chat;
}

/**
 * Look up an adapter by name from the currently-active Chat SDK instance.
 * Returns undefined if the named adapter isn't configured (e.g. Slack
 * tokens not present). Used by `handleCronTrigger` to deliver cron turn
 * replies via `adapter.postMessage(threadId, {text})` without touching
 * Chat SDK's private `adapters` field.
 */
export function getAdapterByName(name: string): Adapter | undefined {
  return currentAdapters[name];
}

/**
 * Snapshot of every secret that feeds an adapter constructor.
 * The single source of truth for "what's in /config/secrets right now".
 */
interface AdapterSecrets {
  telegramBotToken: string;
  slackBotToken: string;
  slackSigningSecret: string;
  whatsappAccessToken: string;
  whatsappAppSecret: string;
  whatsappPhoneNumberId: string;
  teamsAppId: string;
  teamsAppPassword: string;
}

function loadAdapterSecrets(): AdapterSecrets {
  return {
    telegramBotToken: loadSecret("telegram-bot-token"),
    slackBotToken: loadSecret("slack-bot-token"),
    slackSigningSecret: loadSecret("slack-signing-secret"),
    whatsappAccessToken: loadSecret("whatsapp-access-token"),
    whatsappAppSecret: loadSecret("whatsapp-app-secret"),
    whatsappPhoneNumberId: loadSecret("whatsapp-phone-number-id"),
    teamsAppId: loadSecret("teams-app-id"),
    teamsAppPassword: loadSecret("teams-app-password"),
  };
}

function hashSecrets(secrets: AdapterSecrets): string {
  return crypto.createHash("sha256").update(JSON.stringify(secrets)).digest("hex");
}

/**
 * Initialize (or re-initialize) Chat SDK with all configured adapters.
 * Idempotent: each call replaces the module-scope `chat` reference with a
 * fresh instance built from the current contents of /config/secrets.
 *
 * The Chat SDK has no native adapter hot-swap (`Chat.adapters` is private
 * readonly, adapters store credentials in private readonly fields), so the
 * only way to pick up rotated tokens is to construct a new Chat instance.
 *
 * Telegram's `setWebhook` is only re-called when the bot token actually
 * changed, so no-op rebuilds don't spam the Telegram API.
 */
export function initChatSdk(): void {
  const secrets = loadAdapterSecrets();
  const adapters: Record<string, Adapter> = {};

  // Telegram adapter (webhook mode)
  if (secrets.telegramBotToken) {
    const webhookSecret = crypto
      .createHash("sha256")
      .update(secrets.telegramBotToken)
      .digest("hex")
      .slice(0, 64);
    adapters.telegram = createTelegramAdapter({
      botToken: secrets.telegramBotToken,
      mode: "webhook",
      secretToken: webhookSecret,
    });
    if (secrets.telegramBotToken !== currentTelegramToken) {
      registerTelegramWebhook(secrets.telegramBotToken, webhookSecret);
    }
  }

  // Slack adapter
  if (secrets.slackBotToken && secrets.slackSigningSecret) {
    adapters.slack = createSlackAdapter({
      botToken: secrets.slackBotToken,
      signingSecret: secrets.slackSigningSecret,
    });
    rootLogger.info({ event: "chat.adapter.configured", adapterName: "slack" }, "slack adapter configured");
  }

  // WhatsApp adapter — appSecret is required by @chat-adapter/whatsapp
  // (Meta's X-Hub-Signature-256 webhook signature verification). Skipping
  // initialization when it's missing prevents the reload loop a partial
  // setup would otherwise trigger.
  if (
    secrets.whatsappAccessToken &&
    secrets.whatsappPhoneNumberId &&
    secrets.whatsappAppSecret
  ) {
    adapters.whatsapp = createWhatsAppAdapter({
      accessToken: secrets.whatsappAccessToken,
      appSecret: secrets.whatsappAppSecret,
      phoneNumberId: secrets.whatsappPhoneNumberId,
      verifyToken: crypto
        .createHash("sha256")
        .update(secrets.whatsappAccessToken)
        .digest("hex")
        .slice(0, 32),
    });
    rootLogger.info({ event: "chat.adapter.configured", adapterName: "whatsapp" }, "whatsapp adapter configured");
  }

  // Microsoft Teams adapter
  if (secrets.teamsAppId && secrets.teamsAppPassword) {
    adapters.teams = createTeamsAdapter({
      appId: secrets.teamsAppId,
      appPassword: secrets.teamsAppPassword,
    });
    rootLogger.info({ event: "chat.adapter.configured", adapterName: "teams" }, "teams adapter configured");
  }

  // Update fingerprints regardless of adapter count so a transition from
  // "some adapters configured" → "none configured" is also detected.
  currentSecretsHash = hashSecrets(secrets);
  currentTelegramToken = secrets.telegramBotToken;

  const previous = chat;

  if (Object.keys(adapters).length === 0) {
    chat = null;
    currentAdapters = {};
    rootLogger.info({ event: "chat.init.no_adapters" }, "no adapters configured, Chat SDK disabled");
  } else {
    const next = new Chat({
      adapters,
      state: createMemoryState(),
      concurrency: "queue",
      userName: "agent",
    });

    next.onNewMention(handleMessage);
    next.onDirectMessage(handleMessage);

    // Atomic swap — in-flight handlers keep using the old `chat`; new webhook
    // POSTs read this new instance from module scope.
    chat = next;
    // Keep our own reference to the adapters map — Chat SDK exposes only
    // `chat.webhooks` publicly, not `chat.adapters`. We need direct adapter
    // access to call `postMessage()` for cron-triggered reply delivery.
    currentAdapters = adapters;
    rootLogger.info(
      { event: "chat.init.ready", adapters: Object.keys(adapters) },
      "chat sdk initialized",
    );
  }

  // Best-effort cleanup of the previous instance. shutdown() just invokes
  // each adapter's optional disconnect() hook — it does not abort in-flight
  // handlers, so this is safe for the rebuild path.
  if (previous) {
    previous.shutdown().catch((err) => {
      logCatch(rootLogger, "chat.previous_shutdown.failed", err);
    });
  }
}

/**
 * Check whether any adapter secret file has changed and, if so, rebuild
 * the Chat SDK. Called periodically from index.ts.
 */
export function maybeReloadChatSdk(): void {
  const next = loadAdapterSecrets();
  const nextHash = hashSecrets(next);
  if (nextHash === currentSecretsHash) return;
  rootLogger.info({ event: "chat.reload.secrets_changed" }, "rebuilding chat sdk");
  initChatSdk();
}

// ---------------------------------------------------------------------------
// Chat directory observation writer
// ---------------------------------------------------------------------------

/**
 * POST one observation event to the Agent Platform API. The Lambda
 * upserts a chat row + a person row in the example-chat-directory DDB table
 * (PK workspaceId, SK chat#{adapter}#{threadId} or person#{adapter}#{userId}).
 *
 * Fire-and-forget: errors are logged but never block the turn. A failed
 * observation just means the same chat/person will be re-observed on
 * the next inbound message.
 */
/**
 * Extract a chat title and precise type from the adapter-specific raw
 * message payload. For Telegram, `message.raw.chat` carries the chat
 * metadata (title for groups/channels, first_name/last_name for DMs,
 * type string). Other adapters follow similar patterns — add cases as
 * they're wired.
 */
function extractChatInfo(
  adapterName: string,
  message: Message,
  thread: Thread,
): { title: string; type: string } {
  const fallback = {
    title: "",
    type: thread.isDM === true ? "dm" : "group",
  };

  const raw = message.raw as unknown as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return fallback;

  if (adapterName === "telegram") {
    const chat = (raw.chat ?? {}) as Record<string, unknown>;
    const type = typeof chat.type === "string" ? chat.type : fallback.type;
    let title = "";
    if (typeof chat.title === "string" && chat.title) {
      title = chat.title;
    } else {
      // DM — synthesize from first/last/username
      const first = typeof chat.first_name === "string" ? chat.first_name : "";
      const last = typeof chat.last_name === "string" ? chat.last_name : "";
      const username = typeof chat.username === "string" ? chat.username : "";
      title = [first, last].filter(Boolean).join(" ") || (username ? `@${username}` : "");
    }
    return { title, type };
  }

  return fallback;
}

function writeChatObservation(opts: {
  adapterName: string;
  threadId: string;
  thread: Thread;
  author: Author | undefined;
  message: Message;
}): void {
  const workspaceId = process.env.WORKSPACE_ID || "";

  // `thread.id` is a plain string (the Chat-SDK-encoded form, e.g.
  // "telegram:511199516"). Strip the "<adapter>:" prefix to get the
  // raw platform chat_id.
  const rawChatId = opts.threadId.replace(
    /^(telegram|slack|discord|whatsapp|teams):/,
    "",
  );

  const { title, type } = extractChatInfo(opts.adapterName, opts.message, opts.thread);

  const strippedUserId = (opts.author?.userId || "").replace(
    /^(telegram|slack|discord|whatsapp|teams):/,
    "",
  );

  // Intentionally no message text. The chat directory's purpose is
  // chat/people discovery (threadId, type, author identity, first/last
  // seen) — NOT message history. Keeping message content out of
  // observations prevents one conversation's text from leaking into
  // another via `list_known_chats` or any other directory tool.
  const obs = {
    observationId: crypto.randomUUID(),
    workspaceId,
    ts: new Date().toISOString(),
    adapter: opts.adapterName,
    thread: {
      threadId: opts.threadId,
      chatId: rawChatId,
      type,
      title,
      isDM: opts.thread.isDM === true,
      adapterData: {},
    },
    author: opts.author
      ? {
          userId: strippedUserId,
          userName: opts.author.userName || "",
          fullName: opts.author.fullName || "",
          isBot: opts.author.isBot === true,
        }
      : null,
  };

  // Fire-and-forget — errors are logged but never block the turn. This
  // mirrors the previous file-based behavior (the sidecar would just
  // retry on its next tick); now a failure means the observation is
  // dropped, which is fine — the same chat will be re-observed on the
  // next inbound message.
  platformClient.postChatObservation(obs).catch((err) => {
    logCatch(rootLogger, "chat.observation.post_failed", err, {
      adapterName: opts.adapterName,
      threadId: opts.threadId,
    });
  });
}

// ---------------------------------------------------------------------------
// Unified message handler — all sources
// ---------------------------------------------------------------------------

async function handleMessage(
  thread: Thread,
  message: Message,
  _channelOrContext?: unknown,
  context?: MessageContext,
): Promise<void> {
  // onDirectMessage passes (thread, message, channel, context)
  // onNewMention/onSubscribedMessage passes (thread, message, context)
  const ctx: MessageContext | undefined =
    context ?? (_channelOrContext && typeof _channelOrContext === "object" && "skipped" in _channelOrContext
      ? _channelOrContext as MessageContext : undefined);

  const author = message.author;
  // Chat SDK exposes the adapter name via thread.toJSON() — the
  // SerializedThread shape has {adapterName, channelId, id, isDM}.
  // The previous cast `thread.adapterName` was reading a private class
  // field (ThreadImpl._adapterName) that isn't on the public interface,
  // so it always resolved to "unknown".
  const serialized = thread.toJSON();
  const adapterName = serialized.adapterName || "unknown";
  // Strip adapter-specific prefixes from user IDs
  const rawUserId = (author?.userId || "").replace(/^(telegram|slack|whatsapp|teams):/, "");

  // `thread.id` is a plain string like "telegram:511199516". Strip the
  // "<adapter>:" prefix once — the bare id is used by the membership
  // check (admin-in-group lookup) and the header/session-key builders
  // below.
  const rawThreadIdString = String(thread.id);
  const bareThreadId = rawThreadIdString.replace(
    /^(telegram|slack|discord|whatsapp|teams):/,
    "",
  );

  // Membership check — route by source. The Telegram branch is the
  // only one that admits non-members: in a group where the workspace
  // admin is also present, the admin's presence transitively vets the
  // sender (see `isAdminInTelegramGroup`). `trustedViaAdminGroup` is
  // then surfaced in the turn header so the agent prompt can treat the
  // sender as a regular member instead of a stranger.
  let trustedViaAdminGroup = false;
  if (adapterName === "telegram") {
    const isMember = await isTelegramMember(rawUserId);
    if (!isMember) {
      if (thread.isDM) {
        rootLogger.info(
          { event: "chat.member.rejected", adapterName, userId: rawUserId, reason: "dm_non_member" },
          "telegram non-member DM rejected",
        );
        await thread.post("Sorry, you're not a member of this workspace.");
        return;
      }
      const adminPresent = await isAdminInTelegramGroup(bareThreadId);
      if (!adminPresent) {
        rootLogger.info(
          {
            event: "chat.member.rejected",
            adapterName,
            userId: rawUserId,
            chatId: bareThreadId,
            reason: "no_admin_in_group",
          },
          "telegram non-member in admin-less group dropped",
        );
        return;
      }
      trustedViaAdminGroup = true;
      rootLogger.info(
        {
          event: "chat.member.trusted_via_admin_group",
          adapterName,
          userId: rawUserId,
          chatId: bareThreadId,
        },
        "telegram non-member allowed via admin presence",
      );
    }
  } else if (adapterName === "web") {
    if (!(await isCognitoMember(rawUserId))) {
      rootLogger.info(
        { event: "chat.member.rejected", adapterName, userId: rawUserId },
        "web user not a member",
      );
      return;
    }
  }
  // Slack, WhatsApp, Teams — allow all messages through for now
  // (membership is enforced at the platform level by who has access to the bot)

  // Derive session key and prompt header based on source.
  let sessionKey: string;
  let header: string;
  let chatId = "";
  const senderName = author?.fullName || author?.userName || "Unknown";

  if (adapterName === "telegram") {
    chatId = bareThreadId;
    sessionKey = thread.isDM ? `telegram/dm/${chatId}` : `telegram/group/${chatId}`;
    const uname = author?.userName ? ` @${author.userName}` : "";
    const trustSuffix = trustedViaAdminGroup ? " allowed_via_admin_group=true" : "";
    header = `[telegram ${thread.isDM ? "private" : "group"} chat_id=${chatId} from=${senderName}${uname} telegram_id=${rawUserId}${trustSuffix}]`;
  } else if (adapterName === "slack") {
    sessionKey = `slack/${bareThreadId}`;
    header = `[slack channel=${bareThreadId} from=${senderName} user_id=${rawUserId}]`;
  } else if (adapterName === "whatsapp") {
    chatId = bareThreadId;
    sessionKey = `whatsapp/${chatId}`;
    header = `[whatsapp chat=${chatId} from=${senderName} user_id=${rawUserId}]`;
  } else if (adapterName === "teams") {
    sessionKey = `teams/${bareThreadId}`;
    header = `[teams conversation=${bareThreadId} from=${senderName} user_id=${rawUserId}]`;
  } else {
    // HTTP / web adapter — use channelId from the serialized thread
    sessionKey = `http/${rawUserId}/${serialized.channelId || "default"}`;
    header = `[http caller_id=${rawUserId}]`;
  }

  // Persist chat + author metadata to the Agent Platform API. Feeds the
  // durable chat directory (example-chat-directory DDB table) so
  // list_known_chats / list_known_people surface every chat and person
  // the bot has ever observed. Fire-and-forget.
  writeChatObservation({
    adapterName,
    threadId: String(thread.id),
    thread,
    author: author ?? undefined,
    message,
  });

  // Inject the current UTC time at the top of every turn. Without this,
  // the model would have to call Bash (`date -u`) to get the time, and
  // it tends to hallucinate that `date`/`python3` aren't available
  // despite TOOLS.md saying otherwise. Pre-supplying the time
  // eliminates that whole failure mode for the common "schedule X N
  // minutes from now" / "what time is it" cases.
  const turnTime = `[turn-utc=${new Date().toISOString()}]`;

  // Download attachments (images, files, etc.) before building the prompt.
  // The session cwd is created by runAgentTurnImpl; we pre-create the
  // attachments dir here so files are ready when the agent turn starts.
  const attachments = message.attachments ?? [];
  const savedAttachments: string[] = [];
  if (attachments.length > 0) {
    const sessionDir = path.join(
      "/data/sessions",
      sessionKey.replace(/[^a-zA-Z0-9_\-\/]/g, "_"),
      "workdir",
      "attachments",
    );
    fs.mkdirSync(sessionDir, { recursive: true });

    for (const att of attachments) {
      try {
        const data = att.data
          ? Buffer.isBuffer(att.data) ? att.data : Buffer.from(att.data as any)
          : att.fetchData
            ? await att.fetchData()
            : null;
        if (!data) continue;

        const ext = att.name
          ? path.extname(att.name)
          : att.mimeType?.includes("png") ? ".png"
          : att.mimeType?.includes("jpeg") || att.mimeType?.includes("jpg") ? ".jpg"
          : att.mimeType?.includes("gif") ? ".gif"
          : att.mimeType?.includes("webp") ? ".webp"
          : att.mimeType?.includes("pdf") ? ".pdf"
          : att.type === "image" ? ".jpg"
          : "";
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const filename = att.name || `${ts}_${att.type}${ext}`;
        const filePath = path.join(sessionDir, filename);
        fs.writeFileSync(filePath, data);
        const sizeStr = `${data.length}B`;
        savedAttachments.push(
          `- [${att.type} ${att.mimeType || "unknown"} ${sizeStr}] attachments/${filename}`,
        );
        rootLogger.info(
          {
            event: "chat.attachment.saved",
            adapterName,
            threadId: String(thread.id),
            filename,
            bytes: data.length,
          },
          "attachment saved",
        );
      } catch (err) {
        logCatch(rootLogger, "chat.attachment.download_failed", err, {
          adapterName,
          threadId: String(thread.id),
          attachmentType: att.type,
        });
      }
    }
  }

  // Build prompt — combine skipped messages if any were queued
  const skipped = ctx?.skipped ?? [];
  let prompt: string;
  if (skipped.length > 0) {
    const parts = skipped.map((m) => m.text || "").filter(Boolean);
    parts.push(message.text || "(no text)");
    prompt = `${turnTime}\n${header}\n${parts.join("\n")}`;
    rootLogger.info(
      {
        event: "chat.skipped_combined",
        adapterName,
        threadId: String(thread.id),
        skippedCount: skipped.length,
      },
      "skipped messages combined",
    );
  } else {
    prompt = `${turnTime}\n${header}\n${message.text || "(no text)"}`;
  }

  if (savedAttachments.length > 0) {
    prompt += `\n\n[attachments — saved in your session cwd, use Read on the listed paths]\n${savedAttachments.join("\n")}`;
  }

  rootLogger.info(
    {
      event: "chat.turn.start",
      source: adapterName,
      sessionKey,
      adapterName,
      threadId: String(thread.id),
      userId: rawUserId,
    },
    "turn start",
  );

  try {
    const result = await runAgentTurn({
      sessionKey,
      prompt,
      callerId: rawUserId,
      // Pass the adapter name as-is; TurnSource now includes all adapters.
      // The previous code collapsed everything non-Telegram to "ipc", which
      // was misleading for slack/discord/whatsapp/teams/web turns.
      source: adapterName as TurnSource,
      adapterName,
      threadId: String(thread.id),
    });

    const ctxBase = {
      source: adapterName,
      sessionKey,
      adapterName,
      threadId: String(thread.id),
      userId: rawUserId,
    };
    if (result.reply) {
      rootLogger.info(
        { event: "chat.reply.posting", chars: result.reply.length, ...ctxBase },
        "posting reply",
      );
      try {
        // For Telegram, pre-translate the model's CommonMark to the
        // dialect Telegram's legacy `parse_mode=Markdown` parser
        // accepts (see `telegram-markdown.ts` for the rationale and
        // the exact transformations). Other adapters (Slack, etc.)
        // get the raw model output — Chat SDK's per-adapter
        // converters handle them correctly.
        const reply =
          adapterName === "telegram"
            ? commonMarkToTelegramMarkdown(result.reply)
            : result.reply;
        await thread.post({ markdown: reply });
        rootLogger.info({ event: "chat.reply.posted", ...ctxBase }, "reply posted");
      } catch (postErr) {
        // The Telegram preprocessor handles the common parse-error
        // class up-front; if we still trip a parser, retry once as a
        // plain string so the message at least gets delivered.
        if (isMarkdownParseError(postErr)) {
          logCatch(rootLogger, "chat.reply.markdown_rejected", postErr, {
            ...ctxBase,
            expected: true,
          });
          try {
            await thread.post(result.reply);
            rootLogger.info(
              { event: "chat.reply.posted", fallback: "plain", ...ctxBase },
              "reply posted (plain-text fallback)",
            );
          } catch (fallbackErr) {
            logCatch(rootLogger, "chat.reply.fallback_failed", fallbackErr, ctxBase);
          }
        } else {
          logCatch(rootLogger, "chat.reply.post_failed", postErr, ctxBase);
        }
      }
    } else if (result.error === AT_CAPACITY) {
      // TurnQueue was full or our wait timeout expired before we got a
      // slot. Post a user-visible "busy" message so the message isn't
      // silently dropped — the inbound is still visible in the chat
      // history, the user just sees a hint to retry.
      rootLogger.warn(
        { event: "chat.turn.at_capacity", capacity: result.capacity, ...ctxBase },
        "turn rejected by TurnQueue (at capacity)",
      );
      try {
        await thread.post(renderAtCapacityReply(result.capacity));
      } catch (postErr) {
        logCatch(rootLogger, "chat.busy_notice.post_failed", postErr, ctxBase);
      }
    } else if (result.aborted) {
      // User-initiated cancellation (stop_background_task, parent-turn
      // supersede). The cancellation is deliberate — don't post an
      // error message. Bg tasks surface their own attribution via the
      // bgRegistry's stoppedBy wrapper elsewhere.
      rootLogger.info(
        { event: "chat.turn.aborted", turnId: result.turnId, ...ctxBase },
        "turn aborted by user — no error post",
      );
    } else if (result.error) {
      rootLogger.error(
        { event: "chat.turn.error", turnError: result.error, turnId: result.turnId, ...ctxBase },
        "turn returned error",
      );
      try {
        await thread.post(friendlyTurnError(result));
      } catch (postErr) {
        logCatch(rootLogger, "chat.error_notice.post_failed", postErr, ctxBase);
      }
    }
  } catch (err) {
    const ctxBase = {
      source: adapterName,
      sessionKey,
      adapterName,
      threadId: String(thread.id),
      userId: rawUserId,
    };
    logCatch(rootLogger, "chat.turn.failed", err, ctxBase);
    try {
      // Same fallback as the soft-error branch — from the user's POV
      // these are indistinguishable, and collapsing the strings means
      // one place to add classifier-driven messages later.
      await thread.post(friendlyTurnError(undefined));
    } catch (postErr) {
      logCatch(rootLogger, "chat.error_notice.post_failed", postErr, ctxBase);
    }
  }
}

/** Build the user-facing error string for a failed turn. Two inputs:
 *
 *   - `result` from the soft-error branch, when the turn returned
 *     `{error, turnId}` — we surface user-safe messages verbatim (e.g.
 *     the subscription-expired string from loadWorkspaceConfig) and
 *     append a short `(ref: <8>)` for anything else.
 *   - `undefined` from the outer-catch branch, where the turn threw
 *     before we got a TurnResult — no ref available; flat fallback.
 *
 * User-safe markers: errors that start with a known human-readable
 * prefix get passed through. Everything else collapses to the generic
 * string so raw stack traces or CLI stderr never leak to a chat. */
function friendlyTurnError(result: TurnResult | undefined): string {
  const ref = result?.turnId ? ` (ref: ${result.turnId.slice(0, 8)})` : "";
  const raw = result?.error ?? "";
  if (
    raw.startsWith("This workspace's subscription") ||
    raw.startsWith("Agent credentials are missing")
  ) {
    return raw;
  }
  return `Sorry, I encountered an error${ref}.`;
}

// ---------------------------------------------------------------------------
// Telegram webhook registration
// ---------------------------------------------------------------------------

function registerTelegramWebhook(botToken: string, webhookSecret: string): void {
  const workspaceId = process.env.WORKSPACE_ID;
  const domain = process.env.DOMAIN_NAME;
  if (!workspaceId || !domain) return;

  const webhookUrl = `https://${workspaceId}.${domain}/webhooks/telegram`;

  fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: webhookUrl, secret_token: webhookSecret, allowed_updates: ["message", "callback_query"] }),
  })
    .then(async (resp) => {
      const result = (await resp.json()) as { ok?: boolean; description?: string };
      if (result.ok) {
        rootLogger.info(
          { event: "chat.telegram.webhook_registered", webhookUrl },
          "telegram webhook registered",
        );
      } else {
        rootLogger.error(
          { event: "chat.telegram.webhook_failed", webhookUrl, description: result.description },
          "telegram setWebhook failed",
        );
      }
    })
    .catch((err) =>
      logCatch(rootLogger, "chat.telegram.webhook_failed", err, { webhookUrl }),
    );
}

// ---------------------------------------------------------------------------
// Webhook HTTP handler (converts Node.js request → Web API Request for Chat SDK)
// ---------------------------------------------------------------------------

function readNodeBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function toWebRequest(req: http.IncomingMessage, body: string): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value[0] : value);
  }
  const method = req.method || "POST";
  // GET/HEAD requests (e.g. Meta's WhatsApp webhook verification challenge)
  // must not carry a body — the Fetch Request constructor throws
  // "Request with GET/HEAD method cannot have body." otherwise.
  const hasBody = method !== "GET" && method !== "HEAD";
  return new Request(`http://${req.headers.host}${req.url}`, {
    method,
    headers,
    body: hasBody ? body : undefined,
  });
}

async function forwardWebResponse(webResponse: Response, res: http.ServerResponse): Promise<void> {
  res.writeHead(webResponse.status, {
    "Content-Type": webResponse.headers.get("content-type") || "application/json",
  });
  res.end(await webResponse.text());
}

/**
 * Handle a platform webhook request. Routes to the correct Chat SDK adapter.
 */
export async function handleWebhook(
  adapterName: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  if (!chat) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Chat SDK not initialized" }));
    return;
  }

  const webhookHandler = (chat.webhooks as Record<string, (req: Request) => Promise<Response>>)[adapterName];
  if (!webhookHandler) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `No adapter: ${adapterName}` }));
    return;
  }

  try {
    const body = await readNodeBody(req);
    const webResponse = await webhookHandler(toWebRequest(req, body));
    await forwardWebResponse(webResponse, res);
  } catch (err) {
    logCatch(rootLogger, "chat.webhook.failed", err, { adapterName });
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Webhook processing failed" }));
  }
}

// ---------------------------------------------------------------------------
// HTTP chat — processes a message through Chat SDK's web pipeline
// ---------------------------------------------------------------------------

/**
 * Submit an HTTP chat message through Chat SDK.
 * Creates a synthetic message event and processes it through the same
 * handler pipeline as Telegram messages.
 */
export async function submitHttpChat(opts: {
  sub: string;
  sessionId: string;
  message: string;
  email?: string;
  onEvent?: (event: unknown) => void;
  abortController?: AbortController;
}): Promise<{ reply: string; sessionId?: string; error?: string; aborted?: boolean }> {
  const sessionKey = `http/${opts.sub}/${opts.sessionId}`;
  const prompt = `[http caller_id=${opts.sub}]\n${opts.message}`;

  rootLogger.info(
    {
      event: "chat.turn.start",
      source: "http",
      sessionKey,
      userId: opts.sub,
    },
    "turn start (http)",
  );

  const result = await runAgentTurn({
    sessionKey,
    prompt,
    callerId: opts.sub,
    callerEmail: opts.email,
    source: "http",
    onEvent: opts.onEvent,
    abortController: opts.abortController,
  });
  if (result.error === AT_CAPACITY) {
    rootLogger.warn(
      { event: "chat.turn.at_capacity", source: "http", sessionKey, userId: opts.sub, capacity: result.capacity },
      "turn rejected by TurnQueue (at capacity)",
    );
    return { reply: renderAtCapacityReply(result.capacity) };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadSecret(name: string): string {
  try {
    return fs.readFileSync(`${CONFIG_DIR}/secrets/${name}`, "utf-8").trim();
  } catch (err) {
    // ENOENT is the normal "never configured" state for most adapters.
    // Other errno values indicate something genuinely wrong with the
    // filesystem and are worth surfacing.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      rootLogger.info(
        { event: "chat.secret.missing", secretName: name, expected: true },
        "secret file not present",
      );
    } else {
      logCatch(rootLogger, "chat.secret.read_failed", err, { secretName: name, code });
    }
    return "";
  }
}

/**
 * Detect whether a `thread.post`/`adapter.postMessage` failure was caused
 * by the platform rejecting the agent's markdown (vs. a network or
 * permission error). Used to decide whether a plain-text retry is safe.
 *
 * Telegram throws a `ValidationError` with `code: 'VALIDATION_ERROR'`
 * and a message like "can't parse entities". Slack returns 400s with
 * specific block-kit complaints. We match permissively on either the
 * adapter's `code` field or any of the well-known parser-error strings.
 */
export function isMarkdownParseError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: string }).code;
  if (code === "VALIDATION_ERROR" || code === "INVALID_BLOCK") return true;
  const msg = (err as { message?: string }).message ?? "";
  return (
    msg.includes("can't parse entities") ||
    msg.includes("Can't find end of the entity") ||
    msg.includes("invalid_blocks") ||
    msg.includes("MarkdownV2")
  );
}

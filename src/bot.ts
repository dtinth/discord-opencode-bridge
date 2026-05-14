import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  ThreadAutoArchiveDuration,
  type Message,
} from "discord.js";
import { createDb, schema, type Db } from "./db";
import { eq } from "drizzle-orm";
import { config as envConfig } from "./config";
import { log } from "./debug";
import {
  createSession,
  promptAsync,
  subscribe,
  type ChannelConfig,
  type OpenCodeEvent,
  type Part,
} from "./opencode";

function startEventListener(
  cfg: ChannelConfig,
  onEvent: (event: OpenCodeEvent) => Promise<void>,
  signal: AbortSignal,
) {
  const run = async () => {
    const stream = subscribe(cfg, signal);
    for await (const event of stream) {
      if (signal.aborted) break;
      log.debug("SSE event", event.type, event.sessionID);
      if (envConfig.debugEventsPath) {
        const fs = await import("fs");
        fs.appendFileSync(envConfig.debugEventsPath, JSON.stringify(event) + "\n");
      }
      await onEvent(event);
    }
    log.debug("SSE stream ended", cfg.directory);
  };
  run();
}

const threadUsers = new Map<string, string>();
const announcedToolParts = new Set<string>();

// Part buffer: messageID → partID → Part
const partBuffer = new Map<string, Map<string, Part>>();
const sseSubscriptions = new Map<string, AbortController>();

function getPart(event: OpenCodeEvent): Part | undefined {
  return event.properties?.part ?? event.part;
}

function shouldSendPart(part: Part, force: boolean): boolean {
  if (part.type === "step-start" || part.type === "step-finish") return false;
  if (part.type === "tool" && part.state?.status === "pending") return false;
  if (!force && part.type === "text" && !part.time?.end) return false;
  if (!force && part.type === "tool" && part.state?.status === "completed") return false;
  return true;
}

function storePart(part: Part, messageID: string): void {
  if (!part.id) return;
  let messageParts = partBuffer.get(messageID);
  if (!messageParts) {
    messageParts = new Map();
    partBuffer.set(messageID, messageParts);
  }
  messageParts.set(part.id, part);
}

export async function startBot() {
  const { db } = createDb(envConfig.databasePath);
  const channels = await db.select().from(schema.channelConfigs);

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, async (c) => {
    log.info(`Bot ready as ${c.user.tag}`);

    if (envConfig.debugEventsPath) {
      log.info(`SSE event debug logging enabled → ${envConfig.debugEventsPath}`);
    }

    const seenPairs = new Set<string>();
    for (const ch of channels) {
      const key = `${ch.serverUrl}|${ch.directory}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);
      ensureEventListener(db, client, ch);
    }

    process.on("SIGINT", () => {
      for (const ac of sseSubscriptions.values()) ac.abort();
      client.destroy();
      process.exit(0);
    });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;
    if (!interaction.inCachedGuild()) return;

    const customId = interaction.customId;
    log.debug("interaction", interaction.user.id, customId);

    // Look up session and config from the thread/channel
    const ts = await db
      .select()
      .from(schema.threadSessions)
      .where(eq(schema.threadSessions.threadId, interaction.channelId))
      .get();
    if (!ts) {
      log.debug("interaction: no session for channel", interaction.channelId);
      await interaction.reply({ content: "No active session in this channel.", ephemeral: true });
      return;
    }

    if (threadUsers.get(interaction.channelId) !== interaction.user.id) {
      log.debug(
        "interaction: user",
        interaction.user.id,
        "not authorized for thread",
        interaction.channelId,
      );
      await interaction.reply({
        content: "Only the user who mentioned the bot can respond.",
        ephemeral: true,
      });
      return;
    }

    const cfgRaw = await db
      .select()
      .from(schema.channelConfigs)
      .where(eq(schema.channelConfigs.channelId, ts.channelId))
      .get();
    if (!cfgRaw) {
      log.debug("interaction: no channel config for", ts.channelId);
      await interaction.reply({ content: "Channel config not found.", ephemeral: true });
      return;
    }
    const cfg: ChannelConfig = cfgRaw;

    await interaction.deferUpdate();
  });

  client.on(Events.MessageCreate, async (msg) => {
    if (msg.author.bot) return;
    log.debug("message", msg.channelId, msg.channel.type, msg.author.id, msg.content.slice(0, 80));

    // For thread messages, look up the config by parent channel ID
    const isThread =
      msg.channel.type === ChannelType.PublicThread ||
      msg.channel.type === ChannelType.PrivateThread;
    const configChannelId =
      isThread && "parentId" in msg.channel && msg.channel.parentId
        ? msg.channel.parentId
        : msg.channelId;
    const cfgRaw = await db
      .select()
      .from(schema.channelConfigs)
      .where(eq(schema.channelConfigs.channelId, configChannelId))
      .get();
    if (!cfgRaw) {
      log.debug("no channel config for", configChannelId, "(from msg", msg.channelId, ")");
      return;
    }

    const cfg: ChannelConfig = cfgRaw;

    if (msg.channel.type === ChannelType.GuildText && isBotMentioned(msg, client)) {
      log.info("channel mention, creating thread+session");
      await handleChannelMention(db, client, msg, cfg);
      return;
    }

    if (
      msg.channel.type === ChannelType.PublicThread ||
      msg.channel.type === ChannelType.PrivateThread
    ) {
      log.debug("message in thread", msg.channelId);
      const ts = await db
        .select()
        .from(schema.threadSessions)
        .where(eq(schema.threadSessions.threadId, msg.channelId))
        .get();
      if (!ts) {
        log.debug("no session mapping for thread", msg.channelId);
        if (isBotMentioned(msg, client)) {
          log.info("bot mentioned, creating new session");
          await handleThreadMentionNewSession(db, client, msg, cfg);
        }
        return;
      }
      log.debug("found session", ts.sessionId, "cursor", ts.lastSentMessageId);
      await handleThreadMessage(db, client, msg, cfg, ts);
    }
  });

  await client.login(envConfig.discordToken);
}

function isBotMentioned(msg: Message, client: Client): boolean {
  return msg.mentions.has(client.user!.id);
}

function formatSystemPreamble(client: Client, threadId: string): string {
  return `<discord-harness>
System message: This session is bridged from Discord.
The bot's user ID is <@${client.user!.id}>.
You are in Discord thread ID ${threadId}.
When you receive new messages, pay attention to the message that mentioned you first, then use the earlier messages as supporting context.
When replying, tag the user who mentioned you using the <@userId> format so they get notified.
</discord-harness>`;
}

function formatUserMessages(messages: Message[]): string {
  const lines = messages.map((m) => {
    const attachments = [...m.attachments.values()].map((a) => ({
      url: a.url,
      name: a.name,
      contentType: a.contentType,
    }));
    return JSON.stringify({
      user: { id: m.author.id, displayName: m.author.displayName },
      content: m.content,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  });
  return `<discord-harness>
New messages from Discord:
${lines.join("\n")}
</discord-harness>`;
}

function buildInitialPrompt(client: Client, threadId: string, messages: Message[]): string {
  return `${formatSystemPreamble(client, threadId)}\n${formatUserMessages(messages)}`;
}

function formatFooter(info: Record<string, unknown>): string | undefined {
  const modelID = info.modelID as string | undefined;
  const finish = info.finish as string | undefined;
  const role = info.role as string | undefined;
  const time = info.time as Record<string, unknown> | undefined;
  if (role !== "assistant" || finish === "tool-calls" || !modelID) return;
  if (!time?.completed) return;
  return `*${modelID}*`;
}

function ensureEventListener(db: Db, client: Client, cfg: ChannelConfig): void {
  const key = `${cfg.serverUrl}|${cfg.directory}`;
  if (sseSubscriptions.has(key)) return;
  const ac = new AbortController();
  startEventListener(
    cfg,
    async (event) => {
      await handleEvent(db, client, event);
    },
    ac.signal,
  );
  sseSubscriptions.set(key, ac);
}

async function flushBufferedParts(
  channel: { send: (content: string) => Promise<unknown> },
  messageID: string,
  force: boolean,
  skipPartId?: string,
): Promise<void> {
  const messageParts = partBuffer.get(messageID);
  if (!messageParts) return;

  const toDelete: string[] = [];
  for (const [partId, part] of messageParts) {
    if (skipPartId && partId === skipPartId) continue;
    if (!shouldSendPart(part, force)) continue;
    if (part.type === "text") {
      const text = (part.text ?? "").trim();
      if (text) await channel.send(`⬥ ${text}`);
    } else if (part.type === "tool") {
      await channel.send(formatToolPart(part));
    }
    toDelete.push(partId);
  }
  for (const id of toDelete) messageParts.delete(id);
  if (messageParts.size === 0) partBuffer.delete(messageID);
}

async function handleChannelMention(db: Db, client: Client, msg: Message, cfg: ChannelConfig) {
  ensureEventListener(db, client, cfg);
  log.debug("creating thread");
  const thread = await msg.startThread({
    name: `OpenCode — ${msg.content.slice(0, 80)}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
  });
  log.debug("thread created", thread.id);
  threadUsers.set(thread.id, msg.author.id);

  log.debug("creating session");
  const sessionId = await createSession(cfg);
  log.debug("session created", sessionId);

  await db.insert(schema.threadSessions).values({
    threadId: thread.id,
    channelId: msg.channelId,
    sessionId,
    lastSentMessageId: msg.id,
  });
  log.debug("mapping stored", thread.id, "->", sessionId);

  log.debug("sending prompt_async");
  await promptAsync(cfg, sessionId, buildInitialPrompt(client, thread.id, [msg]));
  log.debug("prompt_async sent");
}

async function handleThreadMentionNewSession(
  db: Db,
  client: Client,
  msg: Message,
  cfg: ChannelConfig,
) {
  ensureEventListener(db, client, cfg);
  log.debug("fetching recent messages for context");
  const messages = await msg.channel.messages.fetch({ limit: 100 });
  const collected: Message[] = [];
  for (const m of messages.values()) {
    if (m.author.bot) continue;
    if (m.id === msg.id) break;
    collected.push(m);
  }
  collected.reverse();
  collected.push(msg);
  threadUsers.set(msg.channelId, msg.author.id);

  const sessionId = await createSession(cfg);

  await db.insert(schema.threadSessions).values({
    threadId: msg.channelId,
    channelId: msg.channelId,
    sessionId,
    lastSentMessageId: msg.id,
  });

  log.debug("sending prompt_async");
  await promptAsync(cfg, sessionId, buildInitialPrompt(client, msg.channelId, collected));
  log.debug("prompt_async sent");
}

async function handleThreadMessage(
  db: Db,
  client: Client,
  msg: Message,
  cfg: ChannelConfig,
  ts: typeof schema.threadSessions.$inferSelect,
) {
  ensureEventListener(db, client, cfg);
  if (!isBotMentioned(msg, client)) {
    log.debug("bot not mentioned, skipping");
    return;
  }
  threadUsers.set(msg.channelId, msg.author.id);

  log.debug("fetching messages since cursor", ts.lastSentMessageId);
  const messages = await msg.channel.messages.fetch({ limit: 100 });
  const collected: Message[] = [];
  for (const m of messages.values()) {
    if (m.author.bot) continue;
    if (ts.lastSentMessageId && m.id <= ts.lastSentMessageId) break;
    collected.push(m);
  }
  collected.reverse();
  if (collected.length === 0) {
    log.debug("no new messages to send");
    return;
  }
  log.debug("collected", collected.length, "messages");

  const promptText = formatUserMessages(collected);

  log.debug("sending prompt_async to session", ts.sessionId);
  await promptAsync(cfg, ts.sessionId, promptText);
  log.debug("prompt_async sent, updating cursor to", collected[collected.length - 1]!.id);

  await db
    .update(schema.threadSessions)
    .set({ lastSentMessageId: collected[collected.length - 1]!.id })
    .where(eq(schema.threadSessions.threadId, msg.channelId));
}

function getSessionId(event: OpenCodeEvent): string | undefined {
  return event.sessionID ?? event.properties?.sessionID;
}

async function handleEvent(db: Db, client: Client, event: OpenCodeEvent) {
  const sessionId = getSessionId(event);
  if (!sessionId) {
    log.debug("event without sessionID:", event.type);
    return;
  }

  const ts = await db
    .select()
    .from(schema.threadSessions)
    .where(eq(schema.threadSessions.sessionId, sessionId))
    .get();
  if (!ts) {
    log.debug("event for unknown session", sessionId, event.type);
    return;
  }
  log.debug("event", event.type, "session", sessionId, "thread", ts.threadId);

  const channel = await client.channels.fetch(ts.threadId);
  if (!channel?.isTextBased()) return;
  if (!channel.isSendable()) return;

  let lastTypingTime = 0;
  const showTyping = () => {
    const now = Date.now();
    if (now - lastTypingTime < 5000) return;
    lastTypingTime = now;
    if ("sendTyping" in channel)
      (channel as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
  };

  switch (event.type) {
    case "message.part.updated": {
      const part = getPart(event);
      if (!part) break;

      const messageID = part.messageID;

      if (part.type === "text" && part.time?.end) {
        const text = (part.text ?? "").trim();
        if (text) await channel.send(`⬥ ${text}`);
      } else if (part.type === "tool" && part.state?.status === "running") {
        if (messageID) await flushBufferedParts(channel, messageID, true, part.id);
        if (part.id) {
          const key = `${sessionId}-${part.id}`;
          if (announcedToolParts.has(key)) break;
          announcedToolParts.add(key);
          await channel.send(formatToolPart(part));
        }
      } else if (part.type === "step-finish" && messageID) {
        await flushBufferedParts(channel, messageID, true);
      } else {
        showTyping();
      }

      // Buffer parts that can't be sent yet
      if (messageID && part.id) {
        if (
          (part.type === "text" && !part.time?.end) ||
          (part.type === "tool" && part.state?.status === "completed")
        ) {
          storePart(part, messageID);
        }
      }
      break;
    }
    case "message.updated": {
      const info = event.properties?.info as Record<string, unknown> | undefined;
      if (!info) break;

      const infoId = info.id as string | undefined;
      if (infoId) await flushBufferedParts(channel, infoId, false);

      const footer = formatFooter(info);
      if (footer) await channel.send(footer);
      break;
    }
    case "permission.asked": {
      await channel.send(
        `🔒 A permission prompt has appeared in OpenCode. Please approve or reject it directly.`,
      );
      break;
    }
    case "question.asked": {
      await channel.send(
        `❓ A question prompt has appeared in OpenCode. Please answer it directly.`,
      );
      break;
    }
    case "session.updated": {
      const title = event.properties?.info?.title;
      if (typeof title === "string" && title && "setName" in channel) {
        const ch = channel as { name: string; setName: (name: string) => Promise<unknown> };
        if (ch.name !== title) {
          ch.setName(title).catch((err) => log.warn("Failed to rename thread", err));
        }
      }
      break;
    }
    case "session.error": {
      const error = event.properties?.error;
      await channel.send(`❌ **Session error**: ${error?.message ?? "unknown"}`);
      break;
    }
  }
}

// Based on Kimaki's message formatting (https://github.com/remorses/kimaki)
function formatToolPart(part: {
  name?: string;
  tool?: string;
  state?: { title?: string; input?: Record<string, unknown>; status?: string; error?: string };
}): string {
  const tool = part.tool ?? part.name ?? "tool";
  const input = part.state?.input ?? {};
  const icon =
    part.state?.status === "error"
      ? "⨯"
      : tool === "edit" || tool === "write" || tool === "apply_patch"
        ? "◼︎"
        : "┣";
  const description = part.state?.title || "";
  if (tool === "edit") {
    const filePath = String(input.filePath ?? input.file ?? "");
    const added = String(
      input.newString ? String(input.newString).split("\n").length : (input.added ?? "?"),
    );
    const removed = String(
      input.oldString ? String(input.oldString).split("\n").length : (input.removed ?? "?"),
    );
    return `${icon} *${filePath.split("/").pop()}* (+${added}-${removed})`;
  }
  if (tool === "write" && input.filePath) {
    const lines = String(input.content ?? "").split("\n").length;
    return `${icon} *${String(input.filePath).split("/").pop()}* (${lines} lines)`;
  }
  if (tool === "bash") {
    if (description) return `${icon} ${description}`;
    if (input.command) return `${icon} bash _${String(input.command).split("\n")[0]}_`;
    return `${icon} bash`;
  }
  if (tool === "read")
    return `${icon} *${String(input.filePath ?? "")
      .split("/")
      .pop()}*`;
  if (tool === "glob") return `${icon} *${String(input.pattern ?? "")}*`;
  if (tool === "grep") return `${icon} *${String(input.pattern ?? "")}*`;
  if (tool === "webfetch") return `${icon} ${String(input.url ?? "").replace(/^https?:\/\//, "")}`;
  if (tool === "skill") return `${icon} _${String(input.name ?? "")}_`;
  if (tool === "list")
    return `${icon} *${
      String(input.path ?? "")
        .split("/")
        .pop() ||
      input.path ||
      ""
    }*`;
  if (tool === "task" && input.description) return `${icon} task: ${String(input.description)}`;
  return `${icon} ${tool}`;
}

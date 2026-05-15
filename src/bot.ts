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
  getFileContent,
  promptAsync,
  subscribe,
  type ChannelConfig,
  type OpenCodeEvent,
  type Part,
} from "./opencode";
import { ThreadCore, type ThreadCoreDelegate } from "./core/ThreadCore";

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
const sessionCores = new Map<string, ThreadCore>();

function coreForSession(
  sessionId: string,
  channelId: string,
  client: Client,
  threadId: string,
  cfg: ChannelConfig,
): ThreadCore {
  let core = sessionCores.get(sessionId);
  if (core) return core;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let lastTypingTime = 0;
  const coreRef = { current: null as ThreadCore | null };
  const delegate: ThreadCoreDelegate = {
    sendMessage: (reqId, _ch, content, attachments) => {
      client.channels
        .fetch(threadId)
        .then((ch) => {
          if (ch?.isTextBased() && ch.isSendable()) {
            const sendOpts: Record<string, unknown> = { content };
            if (attachments && attachments.length > 0) {
              sendOpts.files = attachments.map((a) => ({
                attachment: a.content,
                name: a.name,
              }));
            }
            (ch as { send: (opts: Record<string, unknown>) => Promise<{ id: string }> })
              .send(sendOpts)
              .then((sent) => {
                coreRef.current?.handleDiscordMessageCreated(reqId, sent.id);
              })
              .catch((err) => log.error("send error", err));
          }
        })
        .catch((err) => log.error("fetch error", err));
    },
    fetchFile: (path, onResult) => {
      getFileContent(cfg, path)
        .then((file) => {
          onResult({ ok: true, file });
        })
        .catch((err) => {
          onResult({ ok: false, path, error: err.message ?? String(err) });
        });
    },
    editMessage: (_ch, msgId, content) => {
      client.channels
        .fetch(threadId)
        .then((ch) => {
          if (ch?.isTextBased()) {
            (
              ch as {
                messages: {
                  fetch: (id: string) => Promise<{ edit: (c: string) => Promise<unknown> }>;
                };
              }
            ).messages
              .fetch(msgId)
              .then((msg) => {
                msg.edit(content).catch((err) => log.error("edit error", err));
              })
              .catch((err) => log.error("fetch msg error", err));
          }
        })
        .catch((err) => log.error("fetch error", err));
    },
    setTimer: (timerId, ms) => {
      const timer = setTimeout(() => {
        timers.delete(timerId);
        coreRef.current?.handleTimerExpired(timerId);
      }, ms);
      timers.set(timerId, timer);
    },
    clearTimer: (timerId) => {
      const timer = timers.get(timerId);
      if (timer) {
        clearTimeout(timer);
        timers.delete(timerId);
      }
    },
    showTyping: () => {
      const now = Date.now();
      if (now - lastTypingTime < 5000) return;
      lastTypingTime = now;
      client.channels
        .fetch(threadId)
        .then((ch) => {
          if (ch?.isTextBased() && "sendTyping" in ch) {
            (ch as { sendTyping: () => Promise<void> }).sendTyping().catch(() => {});
          }
        })
        .catch(() => {});
    },
  };
  core = new ThreadCore(channelId, delegate);
  coreRef.current = core;
  sessionCores.set(sessionId, core);
  return core;
}

const sseSubscriptions = new Map<string, AbortController>();

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

To share files back to the user, use the <discord-attach>path</discord-attach> tag in your response.
The bridge will fetch the file from the filesystem and send it as a Discord attachment.
Example: "Here is the file you requested: <discord-attach>src/main.ts</discord-attach>"
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

  const cfgRaw = await db
    .select()
    .from(schema.channelConfigs)
    .where(eq(schema.channelConfigs.channelId, ts.channelId))
    .get();
  if (!cfgRaw) {
    log.debug("no channel config for", ts.channelId);
    return;
  }
  const cfg: ChannelConfig = cfgRaw;
  const channel = await client.channels.fetch(ts.threadId);
  if (!channel?.isTextBased()) return;
  if (!channel.isSendable()) return;

  if (event.type === "message.part.updated") {
    const core = coreForSession(sessionId, ts.channelId, client, ts.threadId, cfg);
    core.handleOpenCodeEvent(event);
    return;
  }
  if (event.type === "message.updated") {
    const core = coreForSession(sessionId, ts.channelId, client, ts.threadId, cfg);
    core.handleOpenCodeEvent(event);
    return;
  }

  switch (event.type) {
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

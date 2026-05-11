import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  ThreadAutoArchiveDuration,
  type Message,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
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
} from "./opencode";

function startEventListener(
  cfg: ChannelConfig,
  onEvent: (event: OpenCodeEvent) => void,
  signal: AbortSignal,
) {
  const run = async () => {
    let backoff = 500;
    while (!signal.aborted) {
      try {
        log.debug("SSE connecting", cfg.directory);
        const stream = subscribe(cfg, signal);
        backoff = 500;
        log.debug("SSE connected", cfg.directory);
        for await (const event of stream) {
          if (signal.aborted) break;
          log.debug("SSE event", event.type, event.sessionID);
          onEvent(event);
        }
        log.debug("SSE stream ended", cfg.directory);
      } catch (err: unknown) {
        if (signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        log.error("SSE error for", cfg.directory, message);
      }
      if (signal.aborted) return;
      log.warn("SSE reconnecting in", backoff, "ms", cfg.directory);
      await Bun.sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
  run();
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

  const sseSubscriptions = new Map<string, AbortController>();

  client.once(Events.ClientReady, async (c) => {
    log.info(`Bot ready as ${c.user.tag}`);

    const seenPairs = new Set<string>();
    for (const ch of channels) {
      const key = `${ch.serverUrl}|${ch.directory}`;
      if (seenPairs.has(key)) continue;
      seenPairs.add(key);

      const cfg: ChannelConfig = ch;
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

    process.on("SIGINT", () => {
      for (const ac of sseSubscriptions.values()) ac.abort();
      client.destroy();
      process.exit(0);
    });
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

async function handleChannelMention(db: Db, client: Client, msg: Message, cfg: ChannelConfig) {
  log.debug("creating thread");
  const thread = await msg.startThread({
    name: `OpenCode — ${msg.content.slice(0, 80)}`,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
  });
  log.debug("thread created", thread.id);

  log.debug("creating session");
  const sessionId = await createSession(cfg, thread.name);
  log.debug("session created", sessionId);

  await db.insert(schema.threadSessions).values({
    threadId: thread.id,
    channelId: msg.channelId,
    sessionId,
    lastSentMessageId: msg.id,
  });
  log.debug("mapping stored", thread.id, "->", sessionId);

  log.debug("sending prompt_async");
  await promptAsync(cfg, sessionId, msg.content);
  log.debug("prompt_async sent");
}

async function handleThreadMentionNewSession(
  db: Db,
  client: Client,
  msg: Message,
  cfg: ChannelConfig,
) {
  const sessionId = await createSession(cfg, `Session from thread ${msg.channelId}`);

  await db.insert(schema.threadSessions).values({
    threadId: msg.channelId,
    channelId: msg.channelId,
    sessionId,
    lastSentMessageId: msg.id,
  });

  await promptAsync(cfg, sessionId, msg.content);
}

async function handleThreadMessage(
  db: Db,
  client: Client,
  msg: Message,
  cfg: ChannelConfig,
  ts: typeof schema.threadSessions.$inferSelect,
) {
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

  const promptText = collected.map((m) => `[${m.author.displayName}] ${m.content}`).join("\n");

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

function getPart(event: OpenCodeEvent):
  | {
      type?: string;
      text?: string;
      time?: { end?: string };
      name?: string;
      state?: { status?: string; input?: Record<string, unknown> };
    }
  | undefined {
  return event.properties?.part ?? event.part;
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

  switch (event.type) {
    case "message.part.updated": {
      const part = getPart(event);
      if (!part) break;
      if (part.type === "text" && part.time?.end) {
        const text = (part.text ?? "").trim();
        if (text) await channel.send(`⬥ ${text}`);
      }
      if (part.type === "tool" && part.state?.status === "running") {
        await channel.send(formatToolPart(part));
      }
      break;
    }
    case "permission.asked": {
      const props = event.properties;
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`perm_${props?.requestID}_approve`)
          .setLabel("Approve")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`perm_${props?.requestID}_reject`)
          .setLabel("Reject")
          .setStyle(ButtonStyle.Danger),
      );
      await channel.send({
        content: `🔒 **Permission requested**\n${props?.description ?? ""}`,
        components: [row],
      });
      break;
    }
    case "question.asked": {
      const props = event.properties;
      const opts = props?.options ?? [];
      if (opts.length === 0) break;
      const select = new StringSelectMenuBuilder()
        .setCustomId(`q_${props?.requestID}`)
        .setPlaceholder("Choose an option...")
        .addOptions(
          opts.map((opt) => ({
            label: opt.label ?? String(opt.value),
            value: opt.value,
          })),
        );
      const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
      await channel.send({
        content: `❓ **Question**\n${props?.description ?? ""}`,
        components: [row],
      });
      break;
    }
    case "session.error": {
      const error = event.properties?.error;
      await channel.send(`❌ **Session error**: ${error?.message ?? "unknown"}`);
      break;
    }
  }
}

function formatToolPart(part: {
  name?: string;
  state?: { input?: Record<string, unknown> };
}): string {
  const input = part.state?.input ?? {};
  if (part.name === "edit") {
    const file = String(input.file ?? "?");
    const added = String(input.added ?? "?");
    const removed = String(input.removed ?? "?");
    return `◼︎ *${file}* (+${added}-${removed})`;
  }
  if (part.name === "write" && input.path) {
    const path = String(input.path);
    const content = String(input.content ?? "");
    return `◼︎ *${path}* (${content.length} chars)`;
  }
  if (part.name === "bash" && input.command) {
    const command = String(input.command);
    return `┣ bash ${command.split("\n")[0]}`;
  }
  if (part.name === "read" && input.filePath) return `┣ *${String(input.filePath)}*`;
  if (part.name === "glob") return `┣ *${String(input.pattern ?? "?")}*`;
  if (part.name === "grep") return `┣ *${String(input.pattern ?? "?")}*`;
  return `┣ ${part.name ?? "tool"} ${JSON.stringify(input).slice(0, 80)}`;
}

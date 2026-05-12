import { Command } from "commander";
import { PermissionsBitField } from "discord.js";
import { createDb, schema } from "./db";
import { eq } from "drizzle-orm";
import { config } from "./config";

const program = new Command();

program.name("bridge").description("Discord–OpenCode bridge").version("0.1.0");

program
  .command("add-channel")
  .requiredOption("--channel-id <id>", "Discord channel ID")
  .requiredOption("--server-url <url>", "OpenCode server URL")
  .option("--password <pw>", "OpenCode server password")
  .requiredOption("--directory <path>", "Project directory path")
  .action(async (opts) => {
    const { db } = createDb(config.databasePath);
    await db.insert(schema.channelConfigs).values({
      channelId: opts.channelId,
      serverUrl: opts.serverUrl,
      password: opts.password ?? null,
      directory: opts.directory,
    });
    console.log(`Added channel ${opts.channelId} → ${opts.serverUrl} ${opts.directory}`);
  });

program
  .command("remove-channel")
  .requiredOption("--channel-id <id>", "Discord channel ID")
  .action(async (opts) => {
    const { db } = createDb(config.databasePath);
    await db
      .delete(schema.channelConfigs)
      .where(eq(schema.channelConfigs.channelId, opts.channelId));
    console.log(`Removed channel ${opts.channelId}`);
  });

program.command("list-channels").action(async () => {
  const { db } = createDb(config.databasePath);
  const channels = await db.select().from(schema.channelConfigs);
  if (channels.length === 0) {
    console.log("No channels configured.");
    return;
  }
  for (const ch of channels) {
    console.log(`${ch.channelId} → ${ch.serverUrl} ${ch.directory}`);
  }
});

program
  .command("invite")
  .description("Generate a Discord OAuth2 invite URL for the bot")
  .action(() => {
    const token = process.env.DISCORD_TOKEN;
    if (!token) {
      console.error("DISCORD_TOKEN environment variable is required");
      process.exit(1);
    }

    let clientId: string | null = null;

    // Try to extract client ID from old-format bot token
    try {
      const parts = token.split(".");
      if (parts.length >= 2) {
        const decoded = atob(parts[0]!);
        if (/^\d+$/.test(decoded)) {
          clientId = decoded;
        }
      }
    } catch {
      // Not a base64-decodable token (new format)
    }

    if (clientId) {
      const permBit = new PermissionsBitField([
        "ViewChannel",
        "SendMessages",
        "CreatePublicThreads",
        "SendMessagesInThreads",
        "ReadMessageHistory",
        "EmbedLinks",
        "AttachFiles",
      ]).bitfield.toString();
      const url = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permBit}&scope=bot`;
      console.log(`Invite URL:\n${url}`);
    } else {
      console.log("Could not extract client ID from token (new-format token).");
      console.log(
        "Go to https://discord.com/developers/applications, find your bot, and copy the CLIENT ID.",
      );
      console.log("Then visit:");
      console.log(
        "https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=309237763072&scope=bot",
      );
    }
  });

program.command("list-sessions").action(async () => {
  const { db } = createDb(config.databasePath);
  const sessions = await db.select().from(schema.threadSessions);
  if (sessions.length === 0) {
    console.log("No sessions.");
    return;
  }
  for (const s of sessions) {
    console.log(
      `thread=${s.threadId} channel=${s.channelId} session=${s.sessionId} cursor=${s.lastSentMessageId ?? "-"}`,
    );
  }
});

program
  .command("get-session")
  .requiredOption("--thread-id <id>", "Discord thread ID")
  .action(async (opts) => {
    const { db } = createDb(config.databasePath);
    const s = await db
      .select()
      .from(schema.threadSessions)
      .where(eq(schema.threadSessions.threadId, opts.threadId))
      .get();
    if (!s) {
      console.log("No session found for this thread.");
      return;
    }
    console.log(
      `thread=${s.threadId} channel=${s.channelId} session=${s.sessionId} cursor=${s.lastSentMessageId ?? "-"}`,
    );
  });

program
  .command("link-thread")
  .description("Link an existing Discord thread to an existing OpenCode session")
  .requiredOption("--thread-id <id>", "Discord thread ID (numeric)")
  .requiredOption("--session-id <id>", "OpenCode session ID (starts with ses_)")
  .requiredOption("--channel-id <id>", "Discord channel ID (parent channel)")
  .action(async (opts) => {
    if (!/^\d+$/.test(opts.threadId)) {
      console.error("Error: --thread-id must be numeric");
      process.exit(1);
    }
    if (!opts.sessionId.startsWith("ses_")) {
      console.error("Error: --session-id must start with ses_");
      process.exit(1);
    }
    const { db } = createDb(config.databasePath);
    await db.insert(schema.threadSessions).values({
      threadId: opts.threadId,
      channelId: opts.channelId,
      sessionId: opts.sessionId,
    });
    console.log(
      `Linked thread ${opts.threadId} → session ${opts.sessionId} (channel ${opts.channelId})`,
    );
  });

program
  .command("unlink-thread")
  .description("Remove an existing thread-to-session mapping")
  .requiredOption("--thread-id <id>", "Discord thread ID (numeric)")
  .action(async (opts) => {
    if (!/^\d+$/.test(opts.threadId)) {
      console.error("Error: --thread-id must be numeric");
      process.exit(1);
    }
    const { db } = createDb(config.databasePath);
    await db.delete(schema.threadSessions).where(eq(schema.threadSessions.threadId, opts.threadId));
    console.log(`Unlinked thread ${opts.threadId}`);
  });

export { program };

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

export { program };

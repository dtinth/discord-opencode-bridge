import { Command } from "commander";
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

export { program };

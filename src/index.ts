import { program } from "./cli";
import { startBot } from "./bot";

program
  .command("run")
  .description("Start the Discord bot")
  .action(async () => {
    if (!process.env.DISCORD_TOKEN) {
      console.error("DISCORD_TOKEN environment variable is required");
      process.exit(1);
    }
    await startBot();
  });

program.parse(process.argv);

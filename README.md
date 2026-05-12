# Discord–OpenCode Bridge

A standalone bridge that relays messages between Discord threads and OpenCode AI coding sessions. Runs separately from OpenCode — connects to an existing `opencode serve` instance via its HTTP API.

Heavily inspired by [Kimaki](https://github.com/remorses/kimaki), but designed to be lightweight and minimal — this bridge intentionally omits many of Kimaki's features in favor of simplicity.

## Discord bot setup

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. Go to **Bot** in the sidebar and create the bot.
3. Under **Privileged Gateway Intents**, enable:
   - ☑ **Message Content Intent**
4. Copy the bot token and set it as `DISCORD_TOKEN` in your environment.
5. Run the invite command to generate an invite URL:

   ```bash
   export DISCORD_TOKEN=your_bot_token_here
   bun run src/index.ts invite
   ```

   This prints a URL. Open it in a browser to add the bot to your server. The old-format token can be decoded to extract the client ID automatically; if you have a new-format token, the command tells you what to do.

## Usage

```bash
# Set up environment
export DISCORD_TOKEN=your_bot_token
export DATABASE_PATH=./bridge.db

# Add a channel mapping
bun run src/index.ts add-channel \
  --channel-id "123456789" \
  --server-url "http://localhost:4096" \
  --directory "/path/to/project"

# List configured channels
bun run src/index.ts list-channels

# Start the bot
bun run src/index.ts run
```

## Debug logging

```bash
# Enable debug logs at startup
DEBUG=bridge:* bun run src/index.ts run

# Or toggle at runtime without restart — send SIGUSR1 to the process
kill -USR1 <pid>
```

## Permissions and question prompts

This bridge intentionally does **not** implement interactive approval for permission or question prompts from OpenCode. When the model requests a permission or asks a question, the bot sends a notification to the Discord thread telling you to handle it directly in OpenCode.

**Recommendations** for a smoother experience:

- **Permission prompts** — Run OpenCode in a sandboxed environment and [configure all permissions](https://opencode.ai/docs/config/#permissions) to either `allow` or `deny` but never `ask`. This prevents permission prompts from blocking the session.
- **Question prompts** — Set the `question` tool to `deny` in your OpenCode [permissions config](https://opencode.ai/docs/permissions/). When denied, the model will ask you as a normal text question instead of using the tool.

## How it works

- Messages mentioning the bot in a configured text channel create a new Discord thread and an OpenCode session.
- Messages in a thread with an active session are accumulated and sent to the model via `prompt_async`.
- Model responses stream back via SSE events and are posted as individual Discord messages.
- Permission and question requests from the model are not handled interactively — the bot notifies you to handle them directly in OpenCode.

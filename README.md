# Discord–OpenCode Bridge

A standalone bridge that relays messages between Discord threads and OpenCode AI coding sessions. Runs separately from OpenCode — connects to an existing `opencode serve` instance via its HTTP API.

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

## How it works

- Messages mentioning the bot in a configured text channel create a new Discord thread and an OpenCode session
- Messages in a thread with an active session are accumulated and sent to the model via `prompt_async`
- Model responses stream back via SSE events and are posted as individual Discord messages
- Permission and question requests from the model are forwarded as interactive Discord components

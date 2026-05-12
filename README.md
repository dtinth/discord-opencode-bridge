# Discord–OpenCode Bridge

A standalone bridge that relays messages between Discord threads and OpenCode AI coding sessions. Runs separately from OpenCode — connects to one or more `opencode serve` instances via its HTTP API. A single bot can connect to multiple servers, each with different directories.

Heavily inspired by [Kimaki](https://github.com/remorses/kimaki), but designed to be lightweight and minimal — this bridge intentionally omits many of Kimaki's features in favor of simplicity.

## Setup

1. **Prerequisites** — Install [mise](https://mise.jdx.dev) and clone this repository.

2. **Install tools** — `mise install` installs the required version of Bun (defined in `mise.toml`).

3. **Install dependencies** — `bun install`

4. **Configure environment** — Create a `.env` file in the project root with your Discord bot token:

   ```env
   DISCORD_TOKEN=your_bot_token_here
   ```

   `DATABASE_PATH` defaults to `./bridge.db` — set it in `.env` only if you want a different location. Bun autoloads `.env` files, so no export or dotenv command is needed.

   To create a bot and get its token, go to the [Discord Developer Portal](https://discord.com/developers/applications), create a new application, go to **Bot**, create the bot, and enable **Message Content Intent** under Privileged Gateway Intents.

5. **View available commands** — `bun bot` prints the help page with all available commands.

6. **Invite the bot to a server** — `bun bot invite` generates a Discord OAuth2 invite URL with the required permissions. Open the URL in a browser to add the bot. The old-format token can be decoded to extract the client ID automatically; if you have a new-format token, the command tells you what to do.

7. **Link a channel** — Map a Discord channel to an OpenCode server and directory:

   ```bash
   bun bot add-channel \
     --channel-id "123456789" \
     --server-url "http://localhost:4096" \
     --directory "/path/to/project"
   ```

   The `--server-url` is the URL of an `opencode serve` instance. The `--directory` is a filesystem path on that server — this is the unit of project isolation. An optional `--password` can be provided if the server requires authentication.

8. **Start the bot** — `bun bot run` starts the bot. New channel configs can be added or removed at any time with `add-channel` / `remove-channel` — the running bot picks them up without restart, because it reads config from the database on each message.

Once the bot is running, mention it in a linked channel to create a Discord thread and an OpenCode session. Inside the thread, mention the bot again to send new messages to the session.

### Commands

| Command          | Description                                                    |
| ---------------- | -------------------------------------------------------------- |
| `invite`         | Generate a Discord OAuth2 invite URL for the bot               |
| `add-channel`    | Map a Discord channel to an OpenCode server + directory        |
| `list-channels`  | List all configured channel mappings                           |
| `remove-channel` | Remove a channel mapping                                       |
| `run`            | Start the Discord bot                                          |
| `list-sessions`  | List all thread→session mappings                               |
| `get-session`    | Get the session mapping for a specific thread                  |
| `link-thread`    | Manually link a Discord thread to an existing OpenCode session |
| `unlink-thread`  | Remove a thread→session link                                   |

## Debug logging

```bash
# Enable debug logs at startup
DEBUG=bridge:* bun bot run

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

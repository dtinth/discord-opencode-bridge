# Discord–OpenCode Bridge

A standalone bridge that relays messages between Discord threads and OpenCode AI coding sessions. Runs separately from OpenCode — connects to an existing `opencode serve` instance via its HTTP API.

## Language

**Channel Config**:
A mapping that links a Discord channel to an OpenCode server directory. Fields: `channelID`, `serverUrl`, `password`, `directory`.
_Avoid_: Project config, channel mapping

**OpenCode Server**:
An existing `opencode serve` process that the bridge connects to. Each server is identified by its URL and optional password.

**Directory**:
A filesystem path passed to OpenCode via the `x-opencode-directory` header. The unit of project isolation on the server.

**Session**:
An OpenCode session, created and managed via the server API. Mapped one-to-one with a Discord thread.

**Thread**:
A Discord thread created from a channel message. Mapped one-to-one with an OpenCode session.

## Relationships

- A **Channel Config** references exactly one **OpenCode Server**
- A **Channel Config** references exactly one **Directory**
- An **OpenCode Server** serves zero or more **Directories**
- A **Thread** maps to exactly one **Session**
- A **Session** belongs to exactly one **Directory**
- A **Channel** may have many **Threads**
- A **Channel Config** exists per **Channel**
- A **Thread** delivers messages to a **Session** only when the bot is **Mentioned**; unmentioned messages are ignored
- The bridge wraps all **Session** prompts in a **Discord Harness**

The model is instructed that it can output `<discord-attach>path</discord-attach>` tags to share files back to Discord users. The bridge fetches those files from the OpenCode server and sends them as Discord attachments.

**Discord Harness**:
A `<discord-harness>` XML block wrapper for messages sent into OpenCode. Each block contains structured message metadata (user id, displayName) so the agent can identify and respond to users. The initial prompt includes a system preamble block; subsequent prompts include one or more message blocks.
_Avoid_: Raw text, unstructured prompt

**Mention Gate**:
The rule that the bot only delivers thread messages to the **Session** when the bot account is mentioned. This lets team members discuss among themselves and mention the bot when they want AI involvement.

**User Message Metadata**:
JSON-encoded message data per Discord message: `{"user":{"id":"…","displayName":"…"},"content":"…"}`. One message per line inside a `Discord Harness` block.

**Discord Attach Tag**:
An XML tag `<discord-attach>path</discord-attach>` that the model can place in its text output. When the bridge detects this tag, it fetches the file at `path` from the OpenCode server and sends it as a Discord file attachment. The tag is replaced with `📎 path` in the displayed text. Multiple tags in one response are batched into a single attachment message.
_Avoid_: MyST syntax, markdown link interception

**File Attachment**:
A file fetched from the OpenCode server (via `GET /file/content?path=…`) and sent as a Discord attachment. Sent as a follow-up message with a summary of which files were successfully fetched and any errors.
_Avoid_: Inline code blocks

## Flagged ambiguities

- "attachment" was used to mean both Discord attachment uploads and the act of fetching files — resolved: **File Attachment** is the result; **Discord Attach Tag** is the trigger.

## Example dialogue

> **Dev:** "When a user sends a message in a Discord thread, do we create a new Session or find an existing one?"
> **Domain expert:** "A Thread is mapped one-to-one to a Session. If we stored a threadID→sessionID mapping in a previous message, we resume that session. Otherwise, we create a new Session."

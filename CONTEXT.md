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

## Example dialogue

> **Dev:** "When a user sends a message in a Discord thread, do we create a new Session or find an existing one?"
> **Domain expert:** "A Thread is mapped one-to-one to a Session. If we stored a threadID→sessionID mapping in a previous message, we resume that session. Otherwise, we create a new Session."

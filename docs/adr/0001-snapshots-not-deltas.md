# 0001 — Use complete part snapshots, not streaming deltas

The bridge does not use OpenCode's `message.part.delta` SSE events (token-level text deltas). Instead, it waits for `message.part.updated` events where `part.time.end` is set, indicating the part is complete, and sends each complete part as a single Discord message. This follows the same approach as Kimaki, our primary prior art.

**Rationale:** Streaming deltas would require editing a single Discord message as tokens arrive — a fragile pattern (rate limits, race conditions, edit cooldowns). Complete snapshots give us one message per part, no editing, no streaming complexity. The trade-off is that users see responses in chunks rather than character-by-character, which is acceptable for a code assistant.

## Status

Accepted

## Prior Art

Kimaki (`cli/src/session-handler/thread-session-runtime.ts`) deliberately filters out `message.part.delta` events from its event buffer and only processes `message.part.updated` with `part.time.end` set.

## Considered Options

- **Streaming deltas** (`part.delta`): Edit a single message as tokens arrive. Rejected due to Discord API fragility and complexity.
- **Synchronous prompt** (`POST /session/:id/message`): Wait for the entire response, then post. Rejected because it blocks the bridge for potentially minutes.
- **Async + complete snapshots (chosen)**: `prompt_async` + SSE events, post each complete part as a separate message.

## Consequences

- Users see responses in part-sized chunks (one message per text block, tool call, etc.) rather than streaming tokens.
- Simple, robust implementation — no message editing, no token assembly logic.
- Compatible with Discord's rate limits and message creation model.

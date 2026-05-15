# 0002 — ThreadCore is synchronous (CPS for async)

`ThreadCore` is deliberately synchronous — no async functions, no promises, no microtasks. Async operations (fetching files, Discord API calls) are pushed to the delegate via continuation-passing style callbacks.

**Rationale:** Tests need deterministic control over timing. If `ThreadCore` used async/await, tests would need microtask management, fake timers, or real I/O. CPS lets tests provide synchronous mock delegates that invoke callbacks immediately, making the event flow fully synchronous and trivially testable.

**Trade-off:** Delegate implementations are slightly more complex (manual CPS plumbing instead of async/await wrappers). This is acceptable because delegates are thin I/O adaptors, not business logic.

## Status

Accepted

## Considered Options

- **Async ThreadCore** (await/promise): More natural for implementers, but tests require microtask management and race-condition handling.
- **CPS ThreadCore (chosen)**: Synchronous core logic, async pushed to delegate. Tests are deterministic.

## Consequences

- All ThreadCore tests run synchronously — no `await`, no microtask surprises.
- Async operations visible in the delegate interface as CPS callbacks.
- Newcomers may find CPS unfamiliar; documented here and in the interface.

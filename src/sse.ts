import { log } from "./debug";
import type { ChannelConfig, OpenCodeEvent } from "./opencode";

function basicAuth(password: string): string {
  return `Basic ${btoa(`opencode:${password}`)}`;
}

function serverKey(serverUrl: string, password: string | null): string {
  return `${serverUrl}|${password ?? ""}`;
}

type SseEventCallback = (event: OpenCodeEvent) => void;

interface DirectoryListener {
  directory: string;
  callback: SseEventCallback;
}

interface ConnectionState {
  serverUrl: string;
  password: string | null;
  listeners: Set<DirectoryListener>;
  ac: AbortController;
  backoff: number;
  running: boolean;
}

const connections = new Map<string, ConnectionState>();

function getOrCreateConnection(cfg: ChannelConfig): ConnectionState {
  const key = serverKey(cfg.serverUrl, cfg.password);
  let conn = connections.get(key);
  if (!conn) {
    conn = {
      serverUrl: cfg.serverUrl,
      password: cfg.password,
      listeners: new Set(),
      ac: new AbortController(),
      backoff: 500,
      running: false,
    };
    connections.set(key, conn);
  }
  return conn;
}

async function runSseLoop(conn: ConnectionState): Promise<void> {
  conn.running = true;
  while (!conn.ac.signal.aborted) {
    try {
      await streamEvents(conn);
      conn.backoff = 500;
    } catch (err) {
      if (conn.ac.signal.aborted) break;
      log.error("SSE error for", conn.serverUrl, err);
    }
    if (conn.ac.signal.aborted) break;
    log.warn("SSE reconnecting in", conn.backoff, "ms", conn.serverUrl);
    await Bun.sleep(conn.backoff);
    conn.backoff = Math.min(conn.backoff * 2, 30_000);
  }
  conn.running = false;
}

async function streamEvents(conn: ConnectionState): Promise<void> {
  const url = `${conn.serverUrl}/global/event`;
  const headers: Record<string, string> = {};
  if (conn.password) {
    headers["Authorization"] = basicAuth(conn.password);
  }

  log.debug("SSE connecting", conn.serverUrl);
  const res = await fetch(url, { headers, signal: conn.ac.signal });
  if (!res.ok || !res.body) throw new Error(`SSE connection failed: ${res.status}`);
  log.debug("SSE connected", conn.serverUrl);

  const reader = res.body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += new TextDecoder().decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const raw = JSON.parse(line.slice(6));
          dispatch(conn, raw);
        } catch {
          // skip malformed JSON
        }
      }
    }
  } finally {
    reader.releaseLock();
    log.debug("SSE stream ended", conn.serverUrl);
  }
}

function dispatch(conn: ConnectionState, raw: Record<string, unknown>): void {
  const directory = raw.directory as string | undefined;
  const payload = raw.payload as Record<string, unknown> | undefined;
  if (!payload) return;

  const event: OpenCodeEvent = {
    type: (payload.type as string) ?? "unknown",
    sessionID: payload.sessionID as string | undefined,
    properties: payload.properties as OpenCodeEvent["properties"],
    part: payload.part as OpenCodeEvent["part"],
  };

  for (const listener of conn.listeners) {
    if (listener.directory === directory) {
      try {
        listener.callback(event);
      } catch (err) {
        log.error("SSE listener error", directory, event.type, err);
      }
    }
  }
}

export function subscribe(cfg: ChannelConfig, signal: AbortSignal): AsyncGenerator<OpenCodeEvent> {
  const conn = getOrCreateConnection(cfg);
  const queue: OpenCodeEvent[] = [];
  let waker: (() => void) | null = null;

  const listener: DirectoryListener = {
    directory: cfg.directory,
    callback: (event) => {
      queue.push(event);
      waker?.();
      waker = null;
    },
  };

  conn.listeners.add(listener);

  const onAbort = () => {
    conn.listeners.delete(listener);
    if (conn.listeners.size === 0) {
      conn.ac.abort();
      connections.delete(serverKey(cfg.serverUrl, cfg.password));
    }
    waker?.();
    waker = null;
  };

  if (signal.aborted) {
    onAbort();
  } else {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  if (!conn.running) {
    runSseLoop(conn);
  }

  return {
    async next() {
      while (true) {
        if (signal.aborted) return { done: true as const, value: undefined };
        if (queue.length > 0) {
          return { done: false as const, value: queue.shift()! };
        }
        await new Promise<void>((r) => {
          waker = r;
        });
      }
    },
    async return(value: undefined) {
      onAbort();
      return { done: true as const, value };
    },
    async throw(e: unknown) {
      onAbort();
      throw e;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    [Symbol.asyncDispose]() {
      onAbort();
      return Promise.resolve();
    },
  };
}

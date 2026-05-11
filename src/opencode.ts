function basicAuth(password: string): string {
  return `Basic ${btoa(`opencode:${password}`)}`;
}

export interface ChannelConfig {
  channelId: string;
  serverUrl: string;
  password: string | null;
  directory: string;
}

function headers(cfg: ChannelConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "x-opencode-directory": cfg.directory,
    ...(cfg.password ? { Authorization: basicAuth(cfg.password) } : {}),
  };
}

type FetchResponse<T> = { data: T } | { error: { message?: string } };

async function post<T>(cfg: ChannelConfig, path: string, body: unknown): Promise<FetchResponse<T>> {
  const url = new URL(path, cfg.serverUrl).href;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { error: { message: text || res.statusText } };
  }
  const data = (await res.json().catch(() => undefined)) as T;
  return { data };
}

export async function createSession(cfg: ChannelConfig, title?: string): Promise<string> {
  const result = await post<{ id: string }>(cfg, "/session", title ? { title } : {});
  if ("error" in result) throw new Error(`Failed to create session: ${result.error.message}`);
  return result.data.id;
}

export async function respondToPermission(
  cfg: ChannelConfig,
  sessionId: string,
  permissionId: string,
  response: "once" | "always" | "reject",
): Promise<void> {
  const url = new URL(
    `/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
    cfg.serverUrl,
  ).href;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ response }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to respond to permission: ${text || res.statusText}`);
  }
}

export async function promptAsync(
  cfg: ChannelConfig,
  sessionId: string,
  text: string,
): Promise<void> {
  const url = new URL(`/session/${encodeURIComponent(sessionId)}/prompt_async`, cfg.serverUrl).href;
  const res = await fetch(url, {
    method: "POST",
    headers: headers(cfg),
    body: JSON.stringify({ parts: [{ type: "text", text }] }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to send prompt: ${text || res.statusText}`);
  }
}

export interface Part {
  id?: string;
  type?: string;
  text?: string;
  time?: { end?: string };
  name?: string;
  state?: { status?: string; input?: Record<string, unknown> };
}

export interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  properties?: {
    sessionID?: string;
    id?: string;
    description?: string;
    options?: Array<{ label: string; value: string }>;
    error?: { message?: string };
    part?: Part;
    info?: { title?: string | null };
  };
  part?: Part;
}

async function* sseStream(
  cfg: ChannelConfig,
  path: string,
  signal: AbortSignal,
): AsyncGenerator<OpenCodeEvent> {
  const url = new URL(path, cfg.serverUrl).href;
  const res = await fetch(url, {
    headers: headers(cfg),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`SSE connection failed: ${res.status}`);

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
        if (line.startsWith("data: ")) {
          try {
            const data = JSON.parse(line.slice(6)) as OpenCodeEvent;
            yield data;
          } catch {
            // skip malformed JSON
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function subscribe(cfg: ChannelConfig, signal: AbortSignal): AsyncGenerator<OpenCodeEvent> {
  return sseStream(cfg, `/event?directory=${encodeURIComponent(cfg.directory)}`, signal);
}

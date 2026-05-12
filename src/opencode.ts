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
  tool?: string;
  state?: { status?: string; input?: Record<string, unknown> };
}

export interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  properties?: Record<string, unknown> & {
    sessionID?: string;
    id?: string;
    permission?: string;
    patterns?: string[];
    questions?: Array<{
      header?: string;
      question?: string;
      options?: Array<{ label: string; value: string }>;
    }>;
    description?: string;
    options?: Array<{ label: string; value: string }>;
    error?: { message?: string };
    part?: Part;
    info?: { title?: string | null };
  };
  part?: Part;
}

export { subscribe } from "./sse";

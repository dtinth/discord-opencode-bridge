import type { Part } from "../opencode";
import { splitContent } from "./splitContent";

export interface FileAttachment {
  name: string;
  content: Buffer;
}

export type FileFetchResult =
  | { ok: true; file: FileAttachment }
  | { ok: false; path: string; error: string };

export type DiscordMessage = { edit: (c: string) => Promise<unknown> };
export type DiscordMessagePromise = Promise<DiscordMessage>;

export interface SendMessageOptions {
  channelId: string;
  content: string;
  attachments?: FileAttachment[];
  onSent?: () => void;
  flags?: number;
}

export interface ThreadCoreDelegate {
  sendMessage(options: SendMessageOptions): Promise<DiscordMessage>;
  showTyping(): void;
  fetchFile(path: string, onResult: (result: FileFetchResult) => void): void;
}

export interface OpenCodeEvent {
  type: string;
  sessionID?: string;
  properties?: Record<string, unknown>;
  part?: Part;
}

export function formatFooter(info: Record<string, unknown>): string | undefined {
  const modelID = info.modelID as string | undefined;
  const finish = info.finish as string | undefined;
  const role = info.role as string | undefined;
  const time = info.time as Record<string, unknown> | undefined;
  if (role !== "assistant" || finish === "tool-calls" || !modelID) return;
  if (!time?.completed) return;
  return `*${modelID}*`;
}

function getPart(event: OpenCodeEvent): Part | undefined {
  const props = event.properties as Record<string, unknown> | undefined;
  return (props?.part as Part | undefined) ?? event.part;
}

function formatToolPart(part: {
  name?: string;
  tool?: string;
  state?: { title?: string; input?: Record<string, unknown>; status?: string; error?: string };
}): string {
  const tool = part.tool ?? part.name ?? "tool";
  const input = part.state?.input ?? {};
  const icon =
    part.state?.status === "error"
      ? "⨯"
      : tool === "edit" || tool === "write" || tool === "apply_patch"
        ? "◼︎"
        : "┣";
  const description = part.state?.title || (input as Record<string, string>)?.description || "";
  if (tool === "edit") {
    const filePath = String(input.filePath ?? input.file ?? "");
    const added = String(
      input.newString ? String(input.newString).split("\n").length : (input.added ?? "?"),
    );
    const removed = String(
      input.oldString ? String(input.oldString).split("\n").length : (input.removed ?? "?"),
    );
    return `${icon} *${filePath.split("/").pop()}* (+${added}-${removed})`;
  }
  if (tool === "write" && input.filePath) {
    const lines = String(input.content ?? "").split("\n").length;
    return `${icon} *${String(input.filePath).split("/").pop()}* (${lines} lines)`;
  }
  if (tool === "bash") {
    if (description) return `${icon} ${description}`;
    if (input.command) return `${icon} bash _${String(input.command).split("\n")[0]}_`;
    return `${icon} bash`;
  }
  if (tool === "read")
    return `${icon} *${String(input.filePath ?? "")
      .split("/")
      .pop()}*`;
  if (tool === "glob") return `${icon} *${String(input.pattern ?? "")}*`;
  if (tool === "grep") return `${icon} *${String(input.pattern ?? "")}*`;
  if (tool === "webfetch") return `${icon} ${String(input.url ?? "").replace(/^https?:\/\//, "")}`;
  if (tool === "skill") return `${icon} _${String(input.name ?? "")}_`;
  if (tool === "list")
    return `${icon} *${
      String(input.path ?? "")
        .split("/")
        .pop() ||
      input.path ||
      ""
    }*`;
  if (tool === "task" && input.description) return `${icon} task: ${String(input.description)}`;
  return `${icon} ${tool}`;
}

const DISCORD_MAX_MESSAGE_LENGTH = 2000;

export class ThreadCore {
  private channelId: string;
  private delegate: ThreadCoreDelegate;
  private lastTextPromise: DiscordMessagePromise | null = null;
  private lastTextCleanText: string | null = null;
  private toolMsg: DiscordMessagePromise | null = null;
  private toolParts = new Map<string, Part>();

  constructor(channelId: string, delegate: ThreadCoreDelegate) {
    this.channelId = channelId;
    this.delegate = delegate;
  }

  private buildToolComposite(): string {
    return [...this.toolParts.values()]
      .filter((p) => p.state?.status !== "pending")
      .map(formatToolPart)
      .join("\n");
  }

  handleOpenCodeEvent(event: OpenCodeEvent): void {
    const part = getPart(event);
    if (event.type === "message.part.updated" && part) {
      const messageID = part.messageID;
      if (part.type === "text" && part.time?.end && part.text?.trim() && messageID) {
        const { cleanText, paths } = this.parseAttachmentTags(part.text.trim());
        const content = `⬥ ${cleanText}`;
        this.lastTextCleanText = cleanText;
        this.lastTextPromise = this.sendContent(content, undefined, () => {
          if (paths.length > 0) {
            this.startAttachmentBatch(this.channelId, paths);
          }
        });
      } else if (part.type === "tool" && messageID) {
        if (part.state?.status === "pending") return;
        if (part.id) {
          this.toolParts.set(part.id, part);
        }
        const composite = this.buildToolComposite();
        if (this.toolMsg && composite.length <= DISCORD_MAX_MESSAGE_LENGTH) {
          this.toolMsg = this.toolMsg.then((msg) => msg.edit(composite).then(() => msg));
        } else {
          this.toolMsg = null;
          this.toolParts.clear();
          if (part.id) this.toolParts.set(part.id, part);
          this.toolMsg = this.delegate.sendMessage({
            channelId: this.channelId,
            content: this.buildToolComposite(),
            flags: 1 << 12,
          });
        }
      } else {
        this.delegate.showTyping();
      }
    } else if (event.type === "message.updated") {
      const props = event.properties as Record<string, unknown> | undefined;
      const info = props?.info as Record<string, unknown> | undefined;
      if (!info) return;
      const infoId = info.id as string | undefined;
      if (!infoId) return;

      const footer = formatFooter(info);

      if (this.lastTextPromise && footer) {
        const fullContent = `⬥ ${this.lastTextCleanText} — ${footer}`;
        if (fullContent.length <= DISCORD_MAX_MESSAGE_LENGTH) {
          this.lastTextPromise.then((msg) => msg.edit(fullContent).catch(() => {}));
          this.lastTextPromise = null;
          this.lastTextCleanText = null;
          return;
        }
      }

      if (footer) {
        this.sendContent(`— ${footer}`);
      }

      if (info.finish === "stop") {
        this.toolMsg = null;
        this.toolParts.clear();
      }
    }
  }

  private sendContent(
    content: string,
    attachments?: FileAttachment[],
    onAllSent?: () => void,
    flags?: number,
  ): DiscordMessagePromise {
    const chunks = splitContent(content);
    let resolvePromise: (msg: DiscordMessage) => void;
    const promise = new Promise<DiscordMessage>((r) => {
      resolvePromise = r;
    });
    let index = 0;
    const sendNext = () => {
      if (index >= chunks.length) {
        onAllSent?.();
        return;
      }
      const isLast = index === chunks.length - 1;
      const opts: SendMessageOptions = {
        channelId: this.channelId,
        content: chunks[index]!,
        flags,
      };
      if (isLast && attachments) {
        opts.attachments = attachments;
      }
      this.delegate.sendMessage(opts).then((msg) => {
        index++;
        if (isLast) {
          onAllSent?.();
          resolvePromise(msg);
        } else {
          sendNext();
        }
      });
    };
    sendNext();
    return promise;
  }

  private parseAttachmentTags(text: string): { cleanText: string; paths: string[] } {
    const paths: string[] = [];
    const cleanText = text.replace(
      /<discord-attach>([^<]+)<\/discord-attach>/g,
      (_match, path: string) => {
        paths.push(path);
        return `📎 ${path}`;
      },
    );
    return { cleanText, paths };
  }

  private startAttachmentBatch(channelId: string, paths: string[]): void {
    const total = paths.length;
    let completed = 0;
    const results: FileFetchResult[] = new Array(total);

    for (let i = 0; i < total; i++) {
      const index = i;
      const path: string = paths[i]!;
      this.delegate.fetchFile(path, (result) => {
        results[index] = result;
        completed++;
        if (completed === total) {
          this.sendAttachmentResults(channelId, results);
        }
      });
    }
  }

  private sendAttachmentResults(channelId: string, results: FileFetchResult[]): void {
    const chunkSize = 10;
    for (let i = 0; i < results.length; i += chunkSize) {
      this.sendAttachmentChunk(channelId, results.slice(i, i + chunkSize));
    }
  }

  private sendAttachmentChunk(channelId: string, results: FileFetchResult[]): void {
    const okFiles: FileAttachment[] = [];
    const lines: string[] = [];

    for (const r of results) {
      if (r.ok) {
        okFiles.push(r.file);
        lines.push(`✅ ${r.file.name}`);
      } else {
        lines.push(`⚠️ ${r.path}: ${r.error}`);
      }
    }

    const text = `📎 ${lines.join("\n")}`;
    this.sendContent(text, okFiles);
  }
}

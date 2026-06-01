import type { Part } from "../opencode";
import { splitContent } from "./splitContent";

export interface FileAttachment {
  name: string;
  content: Buffer;
}

export type FileFetchResult =
  | { ok: true; file: FileAttachment }
  | { ok: false; path: string; error: string };

export interface MessageRef {
  edit(content: string): void;
}

export interface SendMessageOptions {
  channelId: string;
  content: string;
  attachments?: FileAttachment[];
  onSent?: () => void;
  flags?: number;
}

export interface ThreadCoreDelegate {
  sendMessage(options: SendMessageOptions): MessageRef;
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
  private lastTextRef: MessageRef | null = null;
  private lastTextCleanText: string | null = null;
  private toolRef: MessageRef | null = null;
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

  private finalizeToolGroup(): void {
    if (!this.toolRef) return;
    this.toolRef = null;
    this.toolParts.clear();
  }

  private flushTextRef(): void {
    if (!this.lastTextRef) return;
    this.lastTextRef = null;
    this.lastTextCleanText = null;
  }

  handleOpenCodeEvent(event: OpenCodeEvent): void {
    const part = getPart(event);
    if (event.type === "message.part.updated" && part) {
      const messageID = part.messageID;
      if (part.type === "text" && part.time?.end && part.text?.trim() && messageID) {
        this.finalizeToolGroup();
        this.flushTextRef();
        const { cleanText, paths } = this.parseAttachmentTags(part.text.trim());
        const content = `⬥ ${cleanText}`;
        this.lastTextCleanText = cleanText;
        this.lastTextRef = this.sendContent(content, undefined, () => {
          if (paths.length > 0) {
            this.startAttachmentBatch(this.channelId, paths);
          }
        });
      } else if (part.type === "tool" && messageID) {
        if (part.state?.status === "pending") return;
        this.flushTextRef();
        if (part.id) {
          this.toolParts.set(part.id, part);
        }
        const composite = this.buildToolComposite();
        if (!this.toolRef) {
          this.toolRef = this.delegate.sendMessage({
            channelId: this.channelId,
            content: composite,
            flags: 1 << 12,
          });
        } else if (composite.length > DISCORD_MAX_MESSAGE_LENGTH) {
          this.toolRef = null;
          this.toolParts.clear();
          if (part.id) this.toolParts.set(part.id, part);
          const fresh = this.buildToolComposite();
          this.toolRef = this.delegate.sendMessage({
            channelId: this.channelId,
            content: fresh,
            flags: 1 << 12,
          });
        } else {
          this.toolRef.edit(composite);
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

      if (this.lastTextRef && footer) {
        this.lastTextRef.edit(`⬥ ${this.lastTextCleanText} — ${footer}`);
        this.lastTextRef = null;
        this.lastTextCleanText = null;
        return;
      }
      if (this.lastTextRef && info.finish === "tool-calls") {
        this.lastTextRef = null;
        this.lastTextCleanText = null;
        return;
      }

      if (footer) {
        this.sendContent(`— ${footer}`);
      }
    }
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

  private sendContent(
    content: string,
    attachments?: FileAttachment[],
    onAllSent?: () => void,
    flags?: number,
  ): MessageRef {
    const chunks = splitContent(content);
    return this.sendChunks(chunks, 0, attachments, onAllSent, flags);
  }

  private sendChunks(
    chunks: string[],
    index: number,
    attachments?: FileAttachment[],
    onAllSent?: () => void,
    flags?: number,
  ): MessageRef {
    if (index >= chunks.length) {
      onAllSent?.();
      return null!;
    }
    const chunk = chunks[index]!;
    const isLast = index === chunks.length - 1;
    const opts: SendMessageOptions = {
      channelId: this.channelId,
      content: chunk,
      flags,
    };
    if (isLast && attachments) {
      opts.attachments = attachments;
    }
    opts.onSent = () => this.sendChunks(chunks, index + 1, attachments, onAllSent, flags);
    return this.delegate.sendMessage(opts);
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

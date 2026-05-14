import type { Part } from "../opencode";

export interface ThreadCoreDelegate {
  sendMessage(requestId: string, channelId: string, content: string): void;
  editMessage(channelId: string, messageId: string, content: string): void;
  setTimer(timerId: string, ms: number): void;
  clearTimer(timerId: string): void;
  showTyping(): void;
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

function addFooter(content: string, footer: string): string {
  return `${content} — ${footer}`;
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
  const description = part.state?.title || "";
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

export class ThreadCore {
  private channelId: string;
  private delegate: ThreadCoreDelegate;
  private deferredTexts = new Map<string, { text: string }>();
  private lastTextMessages = new Map<string, { messageId: string; content: string }>();
  private pendingEdits = new Map<string, { messageID: string; content: string }>();
  private announcedToolParts = new Set<string>();
  private sentRunningToolPartIds = new Set<string>();
  private partBuffer = new Map<string, Map<string, Part>>();
  private requestCounter = 0;

  constructor(channelId: string, delegate: ThreadCoreDelegate) {
    this.channelId = channelId;
    this.delegate = delegate;
  }

  private storeBufferedPart(messageID: string, part: Part): void {
    if (!part.id) return;
    let messageParts = this.partBuffer.get(messageID);
    if (!messageParts) {
      messageParts = new Map();
      this.partBuffer.set(messageID, messageParts);
    }
    messageParts.set(part.id, part);
  }

  private shouldSendPart(part: Part, force: boolean): boolean {
    if (part.type === "step-start" || part.type === "step-finish") return false;
    if (part.type === "tool" && part.state?.status === "pending") return false;
    if (!force && part.type === "text" && !part.time?.end) return false;
    if (!force && part.type === "tool" && part.state?.status === "completed") return false;
    return true;
  }

  private flushBufferedParts(messageID: string, force: boolean): void {
    const messageParts = this.partBuffer.get(messageID);
    if (!messageParts) return;

    const toDelete: string[] = [];
    for (const [partId, part] of messageParts) {
      if (!this.shouldSendPart(part, force)) continue;
      if (part.type === "tool") {
        if (part.state?.status === "completed" && this.sentRunningToolPartIds.has(partId)) {
          this.sentRunningToolPartIds.delete(partId);
          toDelete.push(partId);
          continue;
        }
        const reqId = `req_${++this.requestCounter}`;
        this.delegate.sendMessage(reqId, this.channelId, formatToolPart(part));
      }
      toDelete.push(partId);
    }
    for (const id of toDelete) messageParts.delete(id);
    if (messageParts.size === 0) this.partBuffer.delete(messageID);
  }

  private cleanupPendingForMessage(messageID: string): void {
    for (const [reqId, entry] of this.pendingEdits) {
      if (entry.messageID === messageID) {
        this.pendingEdits.delete(reqId);
      }
    }
  }

  private flushDeferredText(messageID: string): void {
    const deferred = this.deferredTexts.get(messageID);
    if (!deferred) return;
    this.deferredTexts.delete(messageID);
    this.delegate.clearTimer(messageID);
    const content = `⬥ ${deferred.text}`;
    const reqId = `req_${++this.requestCounter}`;
    this.delegate.sendMessage(reqId, this.channelId, content);
    this.pendingEdits.set(reqId, { messageID, content });
  }

  handleOpenCodeEvent(event: OpenCodeEvent): void {
    const part = getPart(event);
    if (event.type === "message.part.updated" && part) {
      const messageID = part.messageID;
      if (part.type === "text" && part.time?.end && part.text?.trim() && messageID) {
        this.flushDeferredText(messageID);
        this.delegate.setTimer(messageID, 200);
        this.deferredTexts.set(messageID, { text: part.text.trim() });
      } else if (part.type === "tool" && part.state?.status === "running" && messageID) {
        this.flushDeferredText(messageID);
        if (part.id && !this.announcedToolParts.has(part.id)) {
          this.announcedToolParts.add(part.id);
          this.sentRunningToolPartIds.add(part.id);
          const reqId = `req_${++this.requestCounter}`;
          this.delegate.sendMessage(reqId, this.channelId, formatToolPart(part));
        }
      } else if (
        part.type === "tool" &&
        part.state?.status === "completed" &&
        messageID &&
        part.id
      ) {
        this.storeBufferedPart(messageID, part);
      } else if (part.type === "step-finish" && messageID) {
        this.flushBufferedParts(messageID, true);
      } else {
        this.delegate.showTyping();
      }
    } else if (event.type === "message.updated") {
      const props = event.properties as Record<string, unknown> | undefined;
      const info = props?.info as Record<string, unknown> | undefined;
      if (!info) return;
      const infoId = info.id as string | undefined;
      if (!infoId) return;

      const deferred = this.deferredTexts.get(infoId);
      if (deferred) {
        const footer = formatFooter(info);
        if (footer) {
          this.cleanupPendingForMessage(infoId);
          this.deferredTexts.delete(infoId);
          this.delegate.clearTimer(infoId);
          const reqId = `req_${++this.requestCounter}`;
          this.delegate.sendMessage(reqId, this.channelId, `⬥ ${deferred.text} — ${footer}`);
          return;
        }
        if (info.finish === "tool-calls") {
          this.cleanupPendingForMessage(infoId);
          this.deferredTexts.delete(infoId);
          this.delegate.clearTimer(infoId);
          const reqId = `req_${++this.requestCounter}`;
          this.delegate.sendMessage(reqId, this.channelId, `⬥ ${deferred.text}`);
          return;
        }
        return;
      }

      const previous = this.lastTextMessages.get(infoId);
      if (previous) {
        const footer = formatFooter(info);
        if (footer) {
          this.cleanupPendingForMessage(infoId);
          this.lastTextMessages.delete(infoId);
          this.delegate.editMessage(
            this.channelId,
            previous.messageId,
            addFooter(previous.content, footer),
          );
        }
      }
    }
  }

  handleTimerExpired(timerId: string): void {
    const deferred = this.deferredTexts.get(timerId);
    if (!deferred) return;
    this.deferredTexts.delete(timerId);
    const content = `⬥ ${deferred.text}`;
    const reqId = `req_${++this.requestCounter}`;
    this.delegate.sendMessage(reqId, this.channelId, content);
    this.pendingEdits.set(reqId, { messageID: timerId, content });
  }

  handleDiscordMessageCreated(requestId: string, messageId: string): void {
    const entry = this.pendingEdits.get(requestId);
    if (entry) {
      this.pendingEdits.delete(requestId);
      this.lastTextMessages.set(entry.messageID, { messageId, content: entry.content });
    }
  }
}

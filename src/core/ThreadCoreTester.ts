import {
  ThreadCore,
  type FileFetchResult,
  type ThreadCoreDelegate,
  type OpenCodeEvent,
} from "./ThreadCore";

export class ThreadCoreTester {
  sentMessages: Array<{
    requestId: string;
    content: string;
    attachments?: Array<{ name: string; content: Buffer }>;
  }> = [];
  editedMessages: Array<{ messageId: string; content: string }> = [];
  fileFetches: Array<{ path: string }> = [];
  private timers = new Map<string, number>();
  private fileFetchHandlers = new Map<string, (result: FileFetchResult) => void>();
  private core: ThreadCore;

  constructor(channelId: string) {
    const delegate: ThreadCoreDelegate = {
      sendMessage: (reqId, _ch, content, attachments) => {
        this.sentMessages.push({ requestId: reqId, content, attachments });
      },
      editMessage: (_ch, msgId, content) => {
        this.editedMessages.push({ messageId: msgId, content });
      },
      setTimer: (id, ms) => {
        this.timers.set(id, ms);
      },
      clearTimer: (id) => {
        this.timers.delete(id);
      },
      showTyping: () => {},
      fetchFile: (path, onResult) => {
        this.fileFetches.push({ path });
        this.fileFetchHandlers.set(path, onResult);
      },
    };
    this.core = new ThreadCore(channelId, delegate);
  }

  dispatchOpenCodeEvent(event: OpenCodeEvent): void {
    this.core.handleOpenCodeEvent(event);
  }

  advanceTime(): void {
    const ids = [...this.timers.keys()];
    this.timers.clear();
    for (const id of ids) {
      this.core.handleTimerExpired(id);
    }
  }

  messageCreated(requestId: string, messageId: string): void {
    this.core.handleDiscordMessageCreated(requestId, messageId);
  }

  resolveFileFetch(path: string, result: FileFetchResult): void {
    const handler = this.fileFetchHandlers.get(path);
    if (handler) {
      handler(result);
    }
  }

  resolveAllFileFetches(ok: boolean = true): void {
    for (const [path, handler] of this.fileFetchHandlers) {
      if (ok) {
        handler({
          ok: true,
          file: { name: path.split("/").pop() || path, content: Buffer.from(`content of ${path}`) },
        });
      } else {
        handler({ ok: false, path, error: "file not found" });
      }
    }
    this.fileFetchHandlers.clear();
  }
}

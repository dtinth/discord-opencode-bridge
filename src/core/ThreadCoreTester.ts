import {
  ThreadCore,
  type FileFetchResult,
  type ThreadCoreDelegate,
  type OpenCodeEvent,
  type MessageRef,
} from "./ThreadCore";

export class FakeMessageRef implements MessageRef {
  edits: string[] = [];
  constructor(
    public content: string,
    private onEdit?: (content: string) => void,
  ) {}
  edit(content: string): void {
    this.edits.push(content);
    this.onEdit?.(content);
  }
}

export class ThreadCoreTester {
  sentMessages: Array<{
    content: string;
    attachments?: Array<{ name: string; content: Buffer }>;
  }> = [];
  messageEdits: string[] = [];
  fileFetches: Array<{ path: string }> = [];
  private fileFetchHandlers = new Map<string, (result: FileFetchResult) => void>();
  private core: ThreadCore;
  private pendingOnSent: (() => void)[] = [];

  constructor(channelId: string) {
    const delegate: ThreadCoreDelegate = {
      sendMessage: (opts) => {
        const ref = new FakeMessageRef(opts.content, (c) => this.messageEdits.push(c));
        this.sentMessages.push({ content: opts.content, attachments: opts.attachments });
        if (opts.onSent) this.pendingOnSent.push(opts.onSent);
        return ref;
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
    this.flushOnSent();
  }

  private flushOnSent(): void {
    while (this.pendingOnSent.length > 0) {
      const batch = this.pendingOnSent;
      this.pendingOnSent = [];
      for (const fn of batch) {
        fn();
      }
    }
  }

  resolveFileFetch(path: string, result: FileFetchResult): void {
    const handler = this.fileFetchHandlers.get(path);
    if (handler) {
      handler(result);
      this.flushOnSent();
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
    this.flushOnSent();
  }
}

import { ThreadCore, type ThreadCoreDelegate, type OpenCodeEvent } from "./ThreadCore";

export class ThreadCoreTester {
  sentMessages: Array<{ requestId: string; content: string }> = [];
  editedMessages: Array<{ messageId: string; content: string }> = [];
  private timers = new Map<string, number>();
  private core: ThreadCore;

  constructor(channelId: string) {
    const delegate: ThreadCoreDelegate = {
      sendMessage: (reqId, _ch, content) => {
        this.sentMessages.push({ requestId: reqId, content });
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
}

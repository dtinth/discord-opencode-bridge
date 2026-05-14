import { describe, expect, test } from "bun:test";
import { ThreadCoreTester } from "./ThreadCoreTester";

function textPart(text: string, messageID: string, id = "p1") {
  return {
    type: "message.part.updated" as const,
    properties: { part: { id, type: "text" as const, text, time: { end: "100" }, messageID } },
  };
}

function toolPart(tool: string, status: string, messageID: string, id = "t1") {
  return {
    type: "message.part.updated" as const,
    properties: {
      part: { id, type: "tool" as const, tool, state: { status, input: {} }, messageID },
    },
  };
}

function messageUpdated(messageID: string, modelID: string, finish?: string, completed?: number) {
  const time: Record<string, unknown> = { created: 100 };
  if (completed !== undefined) time.completed = completed;
  return {
    type: "message.updated" as const,
    properties: {
      info: { id: messageID, role: "assistant", modelID, finish, time },
    },
  };
}

describe("ThreadCore", () => {
  test("deferred text + message.updated before time passes → combined send", () => {
    const t = new ThreadCoreTester("ch_1");

    t.dispatchOpenCodeEvent(textPart("Hello", "m1"));
    expect(t.sentMessages).toEqual([]);

    t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 200));
    expect(t.sentMessages).toContainEqual({
      requestId: expect.any(String),
      content: "⬥ Hello — *gpt-4*",
    });
  });

  test("deferred text + time passes before message.updated → send then edit", () => {
    const t = new ThreadCoreTester("ch_1");

    t.dispatchOpenCodeEvent(textPart("Hello", "m1"));
    t.advanceTime();

    expect(t.sentMessages[0]?.content).toBe("⬥ Hello");
    t.messageCreated(t.sentMessages[0]!.requestId, "discord_1");

    t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 500));
    expect(t.editedMessages).toContainEqual({
      messageId: "discord_1",
      content: "⬥ Hello — *gpt-4*",
    });
  });

  test("tool running flushes deferred text before sending tool notification", () => {
    const t = new ThreadCoreTester("ch_1");

    t.dispatchOpenCodeEvent(textPart("Hello", "m1"));
    expect(t.sentMessages).toEqual([]);

    t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1"));

    expect(t.sentMessages).toContainEqual({ requestId: expect.any(String), content: "⬥ Hello" });
    expect(t.sentMessages).toContainEqual({
      requestId: expect.any(String),
      content: expect.stringContaining("bash"),
    });
  });

  test("step-finish flushes completed tool that was not announced as running", () => {
    const t = new ThreadCoreTester("ch_1");

    t.dispatchOpenCodeEvent(toolPart("bash", "completed", "m1", "t1"));
    expect(t.sentMessages).toEqual([]);

    t.dispatchOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "sf1", type: "step-finish", reason: "stop", messageID: "m1" },
      },
    });

    expect(t.sentMessages).toContainEqual({
      requestId: expect.any(String),
      content: expect.stringContaining("bash"),
    });
  });

  test("completed tool skipped if running was already announced", () => {
    const t = new ThreadCoreTester("ch_1");

    t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));
    t.dispatchOpenCodeEvent(toolPart("bash", "completed", "m1", "t1"));
    expect(t.sentMessages).toHaveLength(1);

    t.dispatchOpenCodeEvent({
      type: "message.part.updated",
      properties: {
        part: { id: "sf1", type: "step-finish", reason: "tool-calls", messageID: "m1" },
      },
    });

    expect(t.sentMessages).toHaveLength(1);
  });

  test("intermediate message.updated without time.completed does not flush deferred text", () => {
    const t = new ThreadCoreTester("ch_1");

    t.dispatchOpenCodeEvent(textPart("Hello", "m1"));

    // Intermediate update: finish set but no time.completed
    t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop"));

    // Text should NOT have been sent yet — still waiting for time.completed
    expect(t.sentMessages).toEqual([]);

    // Final update with time.completed
    t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 500));
    expect(t.sentMessages).toContainEqual({
      requestId: expect.any(String),
      content: "⬥ Hello — *gpt-4*",
    });
  });

  test("multiple text parts flush previous deferred text before deferring new one", () => {
    const t = new ThreadCoreTester("ch_1");

    t.dispatchOpenCodeEvent(textPart("First", "m1", "p1"));
    t.dispatchOpenCodeEvent(textPart("Second", "m1", "p2"));

    expect(t.sentMessages).toContainEqual({ requestId: expect.any(String), content: "⬥ First" });

    t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 200));
    expect(t.sentMessages).toContainEqual({
      requestId: expect.any(String),
      content: "⬥ Second — *gpt-4*",
    });
  });
});

import { describe, expect, test } from "bun:test";
import { ThreadCoreTester } from "./ThreadCoreTester";

function textPart(text: string, messageID: string, id = "p1") {
  return {
    type: "message.part.updated" as const,
    properties: { part: { id, type: "text" as const, text, time: { end: "100" }, messageID } },
  };
}

function textPartWithAttach(text: string, filePath: string, messageID: string, id = "p1") {
  return textPart(
    `Some text <discord-attach>${filePath}</discord-attach> more text`,
    messageID,
    id,
  );
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

  describe("attachment tags", () => {
    test("single <discord-attach> tag: replaced with 📂 in text, batch fetch initiated", () => {
      const t = new ThreadCoreTester("ch_1");

      t.dispatchOpenCodeEvent(textPartWithAttach("Some text", "src/foo.ts", "m1"));

      // Tag is replaced in the text message
      expect(t.sentMessages).toHaveLength(0); // still deferred

      t.advanceTime();

      expect(t.sentMessages).toContainEqual({
        requestId: expect.any(String),
        content: "⬥ Some text 📎 src/foo.ts more text",
      });
      // File fetch should have been initiated
      expect(t.fileFetches).toContainEqual({ path: "src/foo.ts" });
    });

    test("single tag with message.updated: tag replaced, batch fetch initiated", () => {
      const t = new ThreadCoreTester("ch_1");

      t.dispatchOpenCodeEvent(textPartWithAttach("Some text", "src/foo.ts", "m1"));
      t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 200));

      expect(t.sentMessages).toContainEqual({
        requestId: expect.any(String),
        content: "⬥ Some text 📎 src/foo.ts more text — *gpt-4*",
      });
      expect(t.fileFetches).toContainEqual({ path: "src/foo.ts" });
    });

    test("when file fetch completes: attachment message sent with file", () => {
      const t = new ThreadCoreTester("ch_1");

      t.dispatchOpenCodeEvent(textPartWithAttach("Some text", "src/foo.ts", "m1"));
      t.advanceTime();

      // Resolve the file fetch
      t.resolveFileFetch("src/foo.ts", {
        ok: true,
        file: { name: "foo.ts", content: Buffer.from("export const x = 1;") },
      });

      // Should have sent an attachment message
      const attachMsg = t.sentMessages.find((m) => m.content.startsWith("📎"));
      expect(attachMsg).toBeDefined();
      expect(attachMsg!.attachments).toHaveLength(1);
      expect(attachMsg!.attachments![0]!.name).toBe("foo.ts");
      expect(attachMsg!.attachments![0]!.content.toString()).toBe("export const x = 1;");
      expect(attachMsg!.content).toContain("✅ foo.ts");
    });

    test("multiple tags batched into single attachment message", () => {
      const t = new ThreadCoreTester("ch_1");

      const text =
        "Here are files: <discord-attach>a.ts</discord-attach> and <discord-attach>b.ts</discord-attach>";
      t.dispatchOpenCodeEvent(textPart(text, "m1"));
      t.advanceTime();

      expect(t.fileFetches).toHaveLength(2);

      // Resolve both fetches
      t.resolveFileFetch("a.ts", {
        ok: true,
        file: { name: "a.ts", content: Buffer.from("// a") },
      });
      t.resolveFileFetch("b.ts", {
        ok: true,
        file: { name: "b.ts", content: Buffer.from("// b") },
      });

      const attachMsg = t.sentMessages.find((m) => m.content.startsWith("📎"));
      expect(attachMsg).toBeDefined();
      expect(attachMsg!.attachments).toHaveLength(2);
      expect(attachMsg!.content).toContain("✅ a.ts");
      expect(attachMsg!.content).toContain("✅ b.ts");
    });

    test("when file fetch fails: error shown in attachment message", () => {
      const t = new ThreadCoreTester("ch_1");

      t.dispatchOpenCodeEvent(textPartWithAttach("Some text", "missing.ts", "m1"));
      t.advanceTime();

      t.resolveFileFetch("missing.ts", {
        ok: false,
        path: "missing.ts",
        error: "File not found",
      });

      const attachMsg = t.sentMessages.find((m) => m.content.startsWith("📎"));
      expect(attachMsg).toBeDefined();
      expect(attachMsg!.attachments).toHaveLength(0);
      expect(attachMsg!.content).toContain("⚠️ missing.ts: File not found");
    });

    test("mixed success and failure: ok files attached, errors reported in text", () => {
      const t = new ThreadCoreTester("ch_1");

      t.dispatchOpenCodeEvent(
        textPart(
          "<discord-attach>ok.ts</discord-attach> <discord-attach>bad.ts</discord-attach>",
          "m1",
        ),
      );
      t.advanceTime();

      t.resolveFileFetch("ok.ts", {
        ok: true,
        file: { name: "ok.ts", content: Buffer.from("ok") },
      });
      t.resolveFileFetch("bad.ts", {
        ok: false,
        path: "bad.ts",
        error: "not found",
      });

      const attachMsg = t.sentMessages.find((m) => m.content.startsWith("📎"));
      expect(attachMsg).toBeDefined();
      expect(attachMsg!.attachments).toHaveLength(1);
      expect(attachMsg!.attachments![0]!.name).toBe("ok.ts");
      expect(attachMsg!.content).toContain("✅ ok.ts");
      expect(attachMsg!.content).toContain("⚠️ bad.ts: not found");
    });
  });
});

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

function toolPart(
  tool: string,
  status: string,
  messageID: string,
  id = "t1",
  input?: Record<string, unknown>,
) {
  return {
    type: "message.part.updated" as const,
    properties: {
      part: {
        id,
        type: "tool" as const,
        tool,
        state: { status, input: input ?? {} },
        messageID,
      },
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

function userMessageUpdated(messageID: string) {
  return {
    type: "message.updated" as const,
    properties: {
      info: { id: messageID, role: "user", time: { created: 100 } },
    },
  } as const;
}

describe("ThreadCore", () => {
  test("text sent immediately, message.updated edits to add footer", async () => {
    const t = new ThreadCoreTester("ch_1");

    await t.dispatchOpenCodeEvent(textPart("Hello", "m1"));
    expect(t.sentMessages).toContainEqual({ content: "⬥ Hello" });

    await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 200));
    expect(t.messageEdits).toContain("⬥ Hello — *gpt-4*");
  });

  test("message.updated without time.completed does not trigger edit", async () => {
    const t = new ThreadCoreTester("ch_1");

    await t.dispatchOpenCodeEvent(textPart("Hello", "m1"));

    await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop"));
    expect(t.messageEdits).toHaveLength(0);

    await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 500));
    expect(t.messageEdits).toContain("⬥ Hello — *gpt-4*");
  });

  test("tool after text sends text then starts tool group", async () => {
    const t = new ThreadCoreTester("ch_1");

    await t.dispatchOpenCodeEvent(textPart("Hello", "m1"));
    expect(t.sentMessages).toContainEqual({ content: "⬥ Hello" });

    await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1"));

    expect(t.sentMessages).toContainEqual({
      content: expect.stringContaining("bash"),
    });
  });

  test("completed tool is sent immediately as tool group (no step-finish needed)", async () => {
    const t = new ThreadCoreTester("ch_1");

    await t.dispatchOpenCodeEvent(toolPart("bash", "completed", "m1", "t1"));

    expect(t.sentMessages).toHaveLength(1);
    expect(t.sentMessages[0]!.content).toContain("bash");
  });

  test("completed tool updates the line via edit instead of sending new message", async () => {
    const t = new ThreadCoreTester("ch_1");

    await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));
    await t.dispatchOpenCodeEvent(toolPart("bash", "completed", "m1", "t1"));

    expect(t.sentMessages).toHaveLength(1);
    expect(t.messageEdits).toHaveLength(1);
  });

  test("intermediate message.updated without time.completed does not affect text", async () => {
    const t = new ThreadCoreTester("ch_1");

    await t.dispatchOpenCodeEvent(textPart("Hello", "m1"));

    await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop"));

    expect(t.sentMessages).toContainEqual({ content: "⬥ Hello" });

    await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 500));
    expect(t.messageEdits).toContain("⬥ Hello — *gpt-4*");
  });

  test("multiple text parts: first sent immediately, second flushes and replaces ref", async () => {
    const t = new ThreadCoreTester("ch_1");

    await t.dispatchOpenCodeEvent(textPart("First", "m1", "p1"));
    expect(t.sentMessages).toContainEqual({ content: "⬥ First" });

    await t.dispatchOpenCodeEvent(textPart("Second", "m1", "p2"));
    expect(t.sentMessages).toContainEqual({ content: "⬥ Second" });

    await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 200));
    expect(t.messageEdits).toContain("⬥ Second — *gpt-4*");
  });

  describe("message splitting", () => {
    test("long text part is split into multiple messages", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(textPart("x".repeat(2500), "m1"));

      expect(t.sentMessages.length).toBeGreaterThan(1);
      const allContent = t.sentMessages.map((m) => m.content).join("");
      expect(allContent).toBe("⬥ " + "x".repeat(2500));
    });

    test("chunks are sent in order", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(textPart("abcde", "m1"));

      expect(t.sentMessages).toHaveLength(1);
      expect(t.sentMessages[0]?.content).toBe("⬥ abcde");
    });
  });

  describe("attachment tags", () => {
    test("single <discord-attach> tag: replaced with 📂 in text, batch fetch initiated", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(textPartWithAttach("Some text", "src/foo.ts", "m1"));

      expect(t.sentMessages).toContainEqual({
        content: "⬥ Some text 📎 src/foo.ts more text",
      });
      expect(t.fileFetches).toContainEqual({ path: "src/foo.ts" });
    });

    test("single tag with message.updated: tag replaced, batch fetch initiated", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(textPartWithAttach("Some text", "src/foo.ts", "m1"));
      await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 200));

      expect(t.messageEdits).toContain("⬥ Some text 📎 src/foo.ts more text — *gpt-4*");
      expect(t.fileFetches).toContainEqual({ path: "src/foo.ts" });
    });

    test("when file fetch completes: attachment message sent with file", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(textPartWithAttach("Some text", "src/foo.ts", "m1"));

      t.resolveFileFetch("src/foo.ts", {
        ok: true,
        file: { name: "foo.ts", content: Buffer.from("export const x = 1;") },
      });

      const attachMsg = t.sentMessages.find((m) => m.content.startsWith("📎"));
      expect(attachMsg).toBeDefined();
      expect(attachMsg!.attachments).toHaveLength(1);
      expect(attachMsg!.attachments![0]!.name).toBe("foo.ts");
      expect(attachMsg!.attachments![0]!.content.toString()).toBe("export const x = 1;");
      expect(attachMsg!.content).toContain("✅ foo.ts");
    });

    test("multiple tags batched into single attachment message", async () => {
      const t = new ThreadCoreTester("ch_1");

      const text =
        "Here are files: <discord-attach>a.ts</discord-attach> and <discord-attach>b.ts</discord-attach>";
      await t.dispatchOpenCodeEvent(textPart(text, "m1"));

      expect(t.fileFetches).toHaveLength(2);

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

    test("when file fetch fails: error shown in attachment message", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(textPartWithAttach("Some text", "missing.ts", "m1"));

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

    test("11 files split into 2 messages (10 + 1)", async () => {
      const t = new ThreadCoreTester("ch_1");

      const tags = Array.from(
        { length: 11 },
        (_, i) => `<discord-attach>file${i}.ts</discord-attach>`,
      );
      await t.dispatchOpenCodeEvent(textPart(tags.join(" "), "m1"));

      expect(t.fileFetches).toHaveLength(11);
      t.resolveAllFileFetches(true);

      const attachMsgs = t.sentMessages.filter((m) => m.content.startsWith("📎"));
      expect(attachMsgs).toHaveLength(2);
      expect(attachMsgs[0]!.attachments).toHaveLength(10);
      expect(attachMsgs[1]!.attachments).toHaveLength(1);
    });

    test("exactly 10 files sent in single message", async () => {
      const t = new ThreadCoreTester("ch_1");

      const tags = Array.from(
        { length: 10 },
        (_, i) => `<discord-attach>file${i}.ts</discord-attach>`,
      );
      await t.dispatchOpenCodeEvent(textPart(tags.join(" "), "m1"));
      t.resolveAllFileFetches(true);

      const attachMsgs = t.sentMessages.filter((m) => m.content.startsWith("📎"));
      expect(attachMsgs).toHaveLength(1);
      expect(attachMsgs[0]!.attachments).toHaveLength(10);
    });

    test("mixed success and failure: ok files attached, errors reported in text", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(
        textPart(
          "<discord-attach>ok.ts</discord-attach> <discord-attach>bad.ts</discord-attach>",
          "m1",
        ),
      );

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

  describe("tool grouping", () => {
    test("first tool in a group sends a new message", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));

      expect(t.sentMessages).toHaveLength(1);
      expect(t.sentMessages[0]!.content).toContain("bash");
    });

    test("second tool in same group edits the first message", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));
      await t.dispatchOpenCodeEvent(toolPart("read", "running", "m1", "t2"));

      expect(t.sentMessages).toHaveLength(1);
      expect(t.messageEdits).toHaveLength(1);
      expect(t.messageEdits[0]).toBe("┣ bash\n┣ **");
    });

    test("tool completed updates the line in the composite", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(toolPart("read", "running", "m1", "t1"));
      await t.dispatchOpenCodeEvent(toolPart("read", "completed", "m1", "t1"));

      expect(t.sentMessages).toHaveLength(1);
      expect(t.messageEdits).toHaveLength(1);
    });

    test("text after tools finalizes the tool group and sends text separately", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));
      await t.dispatchOpenCodeEvent(textPart("Response", "m2"));

      expect(t.sentMessages).toHaveLength(2);
      expect(t.sentMessages[0]!.content).toContain("bash");
      expect(t.sentMessages[1]!.content).toContain("⬥ Response");
    });

    test("tools after text flush text ref then start tool group", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(textPart("Thinking", "m1"));
      await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));

      expect(t.sentMessages).toHaveLength(2);
      expect(t.sentMessages[0]!.content).toContain("Thinking");
      expect(t.sentMessages[1]!.content).toContain("bash");
    });

    test("tool group splits into a new message when composite exceeds length limit", async () => {
      const t = new ThreadCoreTester("ch_1");
      const longLine = "a".repeat(1990);

      await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1", { command: longLine }));
      await t.dispatchOpenCodeEvent(toolPart("read", "running", "m1", "t2"));

      expect(t.sentMessages).toHaveLength(2);
      expect(t.messageEdits).toHaveLength(0);
      expect(t.sentMessages[0]!.content).toContain("bash");
      expect(t.sentMessages[1]!.content).toBe("┣ **");
    });

    test("footer too long to fit in text message is sent separately", async () => {
      const t = new ThreadCoreTester("ch_1");
      const longText = "x".repeat(1992);

      await t.dispatchOpenCodeEvent(textPart(longText, "m1"));
      await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 200));

      // ⬥ + 1992 x's = 1995 chars, + " — *gpt-4*" = 2008 > 2000
      expect(t.sentMessages).toHaveLength(2);
      expect(t.sentMessages[1]!.content).toBe("— *gpt-4*");
    });

    test("message.updated at end finalizes tool group and sends footer", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));
      await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 200));

      expect(t.sentMessages).toHaveLength(2);
      expect(t.sentMessages[1]!.content).toBe("— *gpt-4*");
    });

    test("tools from multiple rounds accumulate in one group", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));
      await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "tool-calls", 200));
      await t.dispatchOpenCodeEvent(toolPart("read", "running", "m2", "t2"));

      expect(t.sentMessages).toHaveLength(1);
      expect(t.messageEdits).toHaveLength(1);
      expect(t.messageEdits[0]!.split("\n")).toHaveLength(2);
    });

    test("text does not finalize tool group", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));
      await t.dispatchOpenCodeEvent(textPart("response", "m2"));
      await t.dispatchOpenCodeEvent(toolPart("read", "running", "m3", "t2"));

      expect(t.sentMessages).toHaveLength(2);
      expect(t.sentMessages[0]!.content).toContain("bash");
      expect(t.sentMessages[1]!.content).toContain("response");
      expect(t.messageEdits).toHaveLength(1);
      expect(t.messageEdits[0]!.split("\n")).toHaveLength(2);
    });

    test("message.updated(tool-calls) does not drop lastTextRef", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(textPart("Hello", "m1"));
      await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "tool-calls", 200));
      await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 300));

      expect(t.messageEdits).toContain("⬥ Hello — *gpt-4*");
    });

    test("footer appended even when tools arrive after last text", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(textPart("Done", "m1"));
      await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));
      await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 200));

      expect(t.messageEdits).toContain("⬥ Done — *gpt-4*");
    });

    test("tool group finalized on message.updated with finish=stop", async () => {
      const t = new ThreadCoreTester("ch_1");

      await t.dispatchOpenCodeEvent(toolPart("bash", "running", "m1", "t1"));
      await t.dispatchOpenCodeEvent(messageUpdated("m1", "gpt-4", "stop", 200));

      expect(t.sentMessages).toHaveLength(2);
      expect(t.sentMessages[1]!.content).toBe("— *gpt-4*");

      await t.dispatchOpenCodeEvent(toolPart("read", "running", "m2", "t2"));
      expect(t.sentMessages).toHaveLength(3);
      expect(t.sentMessages[2]!.content).toBe("┣ **");
    });
  });
});

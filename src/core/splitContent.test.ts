import { describe, expect, test } from "bun:test";
import { splitContent } from "./splitContent";

describe("splitContent", () => {
  test("short content returns single chunk", () => {
    expect(splitContent("Hello", 10)).toEqual(["Hello"]);
  });

  test("empty content returns single empty string", () => {
    expect(splitContent("", 10)).toEqual([""]);
  });

  test("content longer than maxLength is split", () => {
    const result = splitContent("abcdefghijklmno", 5);
    expect(result).toEqual(["abcde", "fghij", "klmno"]);
  });

  test("grapheme clusters are not split", () => {
    const family = "👨‍👩‍👧‍👦"; // 7 code points, 1 grapheme cluster
    const text = `a${family}b${family}c`;
    const result = splitContent(text, 4);
    expect(result).toEqual(["a", family, "b", family, "c"]);
  });

  test("content exactly at maxLength is single chunk", () => {
    expect(splitContent("12345", 5)).toEqual(["12345"]);
  });
});

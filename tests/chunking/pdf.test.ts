import { describe, it, expect } from "vitest";
import { splitPageText } from "../../src/chunking/pdf.js";

describe("splitPageText", () => {
  it("emits one segment for text within the budget", () => {
    const text = "short text on this page";
    const segments = splitPageText(text, 7, 100, 10);

    expect(segments).toEqual([{ pageNum: 7, segment: 0, text }]);
  });

  it("splits long text into overlapping windows", () => {
    const text = "a".repeat(250);
    const segments = splitPageText(text, 3, 100, 20);

    // step = 100 - 20 = 80; segments start at 0, 80, 160 → 3 windows
    expect(segments).toHaveLength(3);
    expect(segments.map((s) => s.segment)).toEqual([0, 1, 2]);
    expect(segments[0].pageNum).toBe(3);
    expect(segments[0].text.length).toBe(100);
    expect(segments[1].text.length).toBe(100);
    expect(segments[2].text.length).toBe(90); // remainder
  });

  it("preserves overlapChars of duplicated content between consecutive windows", () => {
    const text = Array.from({ length: 300 }, (_, i) =>
      String.fromCharCode(65 + (i % 26)),
    ).join("");
    const segments = splitPageText(text, 1, 100, 20);

    for (let i = 0; i + 1 < segments.length; i++) {
      const tail = segments[i].text.slice(-20);
      const head = segments[i + 1].text.slice(0, 20);
      expect(head).toBe(tail);
    }
  });

  it("handles a single-window edge case at the exact budget", () => {
    const text = "x".repeat(100);
    const segments = splitPageText(text, 9, 100, 20);

    expect(segments).toHaveLength(1);
    expect(segments[0].text).toBe(text);
    expect(segments[0].segment).toBe(0);
  });

  it("throws if overlap is not strictly less than the budget", () => {
    expect(() => splitPageText("a".repeat(200), 1, 100, 100)).toThrow(
      /overlapChars/,
    );
    expect(() => splitPageText("a".repeat(200), 1, 100, 150)).toThrow(
      /overlapChars/,
    );
  });

  it("propagates the pageNum onto every emitted segment", () => {
    const segments = splitPageText("a".repeat(500), 42, 100, 20);
    for (const s of segments) {
      expect(s.pageNum).toBe(42);
    }
  });
});

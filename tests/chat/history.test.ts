import { describe, it, expect } from "vitest";
import type { CoreMessage } from "ai";
import { ChatHistory } from "../../src/chat/history.js";

describe("ChatHistory", () => {
  it("appends messages in order and exposes them via get()", () => {
    const history = new ChatHistory();
    const m1: CoreMessage = { role: "user", content: "hello" };
    const m2: CoreMessage = { role: "assistant", content: "hi" };

    history.append(m1, m2);

    expect(history.get()).toEqual([m1, m2]);
    expect(history.size()).toBe(2);
  });

  it("reset() clears all messages", () => {
    const history = new ChatHistory();
    history.append({ role: "user", content: "anything" });
    expect(history.size()).toBe(1);

    history.reset();

    expect(history.get()).toEqual([]);
    expect(history.size()).toBe(0);
  });

  it("preserves order across two sequential runAgent-shaped appends", () => {
    const history = new ChatHistory();

    const turn1User: CoreMessage = { role: "user", content: "Q1" };
    const turn1Assistant: CoreMessage = { role: "assistant", content: "A1" };
    history.replace([turn1User, turn1Assistant]);

    const turn2User: CoreMessage = { role: "user", content: "Q2" };
    const turn2Assistant: CoreMessage = { role: "assistant", content: "A2" };
    history.replace([
      ...history.get(),
      turn2User,
      turn2Assistant,
    ]);

    expect(history.get()).toEqual([
      turn1User,
      turn1Assistant,
      turn2User,
      turn2Assistant,
    ]);
  });

  it("replace() takes a defensive copy so external mutation does not leak in", () => {
    const history = new ChatHistory();
    const source: CoreMessage[] = [{ role: "user", content: "Q" }];

    history.replace(source);
    source.push({ role: "assistant", content: "leak" });

    expect(history.size()).toBe(1);
  });
});

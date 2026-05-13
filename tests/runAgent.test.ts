import { describe, it, expect, vi } from "vitest";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: vi.fn(async () => ({
      text: JSON.stringify({
        answer: "Cheapest bid for ITEM 100 is Alpha at $100.",
        confidence: "high",
        grounded_in_context: true,
        data_caveats: ["Engineer estimate unavailable"],
        sources: [{ type: "csv_row", reference: "csv::file::P1::100" }],
      }),
    })),
  };
});

import { runAgent } from "../src/agent/agent.js";

describe("runAgent end-to-end", () => {
  it("returns a structured AgentAnswer with caveats and sources", async () => {
    const answer = await runAgent("Who has the cheapest bid for ITEM 100?");

    expect(answer.answer).toContain("Alpha");
    expect(answer.confidence).toBe("high");
    expect(answer.grounded_in_context).toBe(true);
    expect(answer.data_caveats).toContain("Engineer estimate unavailable");
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]).toEqual({
      type: "csv_row",
      reference: "csv::file::P1::100",
    });
  });

  it("returns a low-confidence fallback when generateText output isn't JSON", async () => {
    const { generateText } = await import("ai");
    vi.mocked(generateText).mockResolvedValueOnce({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      text: "I have no idea, sorry.",
    } as any);

    const answer = await runAgent("nonsense");
    expect(answer.confidence).toBe("low");
    expect(answer.grounded_in_context).toBe(false);
    expect(answer.data_caveats.length).toBeGreaterThan(0);
  });
});

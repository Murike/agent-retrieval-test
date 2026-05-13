import { describe, it, expect, vi } from "vitest";
import type { SearchResult } from "../src/types.js";

vi.mock("../src/store/vectorStore.js", () => ({
  search: vi.fn(),
  addChunks: vi.fn(),
}));

import { searchDocuments } from "../src/tools/searchDocuments.js";
import { search } from "../src/store/vectorStore.js";

const toolOpts = { toolCallId: "test", messages: [] };

describe("searchDocuments tool", () => {
  it("forwards minQualityScore + source + topK to the store and projects results", async () => {
    const mockedSearch = vi.mocked(search);
    const results: SearchResult[] = [
      {
        chunk: {
          id: "csv::doc::P1::100",
          source: "csv",
          document: "ITEM 100 — ASPHALT (TON): 3 bids in project P1.",
          metadata: {
            id: "csv::doc::P1::100",
            summary: "ITEM 100 — ASPHALT (TON): 3 bids in project P1.",
            rows: [],
            columnMappings: [],
            outliers: [],
            qualityScore: 0.9,
            groundedness: "direct",
            confidence: 0.9,
            caveats: ["Unmapped columns: REGION"],
          },
        },
        score: 0.42,
      },
    ];
    mockedSearch.mockResolvedValueOnce(results);

    const out = await searchDocuments.execute!(
      {
        query: "asphalt",
        source: "csv",
        topK: 5,
        minQualityScore: 0.8,
      },
      toolOpts,
    );

    expect(mockedSearch).toHaveBeenCalledWith("asphalt", {
      source: "csv",
      topK: 5,
      minQualityScore: 0.8,
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      id: "csv::doc::P1::100",
      source: "csv",
      qualityScore: 0.9,
      confidence: 0.9,
      groundedness: "direct",
      caveats: ["Unmapped columns: REGION"],
    });
  });
});

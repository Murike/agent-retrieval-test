import { describe, it, expect, vi } from "vitest";
import type { SearchResult } from "../src/types.js";

vi.mock("../src/store/vectorStore.js", () => ({
  search: vi.fn(),
  addChunks: vi.fn(),
}));

import { queryPlanSet } from "../src/tools/queryPlanSet.js";
import { search } from "../src/store/vectorStore.js";

const toolOpts = { toolCallId: "test", messages: [] };

function pdfResult(id: string, confidence: number): SearchResult {
  return {
    chunk: {
      id,
      source: "pdf",
      document: `page text for ${id}`,
      metadata: {
        id,
        pageNum: 1,
        text: `page text for ${id}`,
        method: confidence === 1 ? "text_layer" : "ocr",
        qualityScore: confidence,
        groundedness: "direct",
        confidence,
        warnings: confidence < 0.7 ? ["Low OCR confidence — content may be inaccurate"] : [],
      },
    },
    score: 0.3,
  };
}

describe("queryPlanSet tool", () => {
  it("excludes low-confidence chunks when requireHighConfidence=true and surfaces a caveat", async () => {
    const mockedSearch = vi.mocked(search);
    mockedSearch.mockResolvedValueOnce([
      pdfResult("pdf::doc::p1", 1.0),
      pdfResult("pdf::doc::p2", 0.5),
    ]);

    const out = await queryPlanSet.execute!(
      { topic: "drainage", requireHighConfidence: true },
      toolOpts,
    );

    expect(mockedSearch).toHaveBeenCalledWith("drainage", {
      source: "pdf",
      topK: 5,
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].id).toBe("pdf::doc::p1");
    expect(out.results[0].confidence).toBe(1);
    expect(out.caveats).toEqual([]);
  });

  it("returns a caveat when all matches fall below the high-confidence threshold", async () => {
    const mockedSearch = vi.mocked(search);
    mockedSearch.mockResolvedValueOnce([
      pdfResult("pdf::doc::p1", 0.4),
      pdfResult("pdf::doc::p2", 0.5),
    ]);

    const out = await queryPlanSet.execute!(
      { topic: "drainage", requireHighConfidence: true },
      toolOpts,
    );

    expect(out.results).toEqual([]);
    expect(out.caveats[0]).toMatch(/No high-confidence PDF text/);
  });
});

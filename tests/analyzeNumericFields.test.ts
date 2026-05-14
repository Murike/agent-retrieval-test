import { describe, it, expect, vi } from "vitest";
import type { CsvChunk } from "../src/types.js";

const fakeChunk: CsvChunk = {
  id: "csv::file::P1::100",
  summary: "ITEM 100 — TEST (EACH): 3 bids in project P1.",
  rows: [
    { PROJ_ID: "P1", ITEM_NO: "100", BIDDER: "Alpha", UNIT_PR: "100", EXT_AMT: "1000" },
    { PROJ_ID: "P1", ITEM_NO: "100", BIDDER: "Beta", UNIT_PR: "110", EXT_AMT: "1100" },
    { PROJ_ID: "P1", ITEM_NO: "100", BIDDER: "Gamma", UNIT_PR: "500", EXT_AMT: "5000" },
  ],
  columnMappings: [
    {
      originalHeader: "PROJ_ID",
      mappedName: "PROJ_ID",
      tier: "synonym",
      confidence: 1,
      role: "identifier",
      semanticLabel: "Project identifier",
    },
    {
      originalHeader: "ITEM_NO",
      mappedName: "ITEM_NO",
      tier: "synonym",
      confidence: 1,
      role: "identifier",
      semanticLabel: "Line item number",
    },
    {
      originalHeader: "BIDDER",
      mappedName: "BIDDER",
      tier: "synonym",
      confidence: 1,
      role: "party",
      semanticLabel: "Bidder / contractor / vendor",
    },
    {
      originalHeader: "UNIT_PR",
      mappedName: "UNIT_PR",
      tier: "synonym",
      confidence: 1,
      role: "price",
      semanticLabel: "Unit price",
    },
    {
      originalHeader: "EXT_AMT",
      mappedName: "EXT_AMT",
      tier: "synonym",
      confidence: 1,
      role: "amount",
      semanticLabel: "Extended (line-total) amount",
    },
  ],
  outliers: [
    {
      party: "Gamma",
      amount: 500,
      deviation: "high",
      methods: ["iqr", "mad", "ratio_to_min"],
      detail: "amount 500 vs median 110.00 (flagged by: iqr, mad, ratio_to_min)",
    },
  ],
  qualityScore: 1,
  groundedness: "direct",
  confidence: 1,
  caveats: [],
};

vi.mock("../src/ingestion/ingestor.js", () => ({
  getAllCsvChunks: () => [fakeChunk],
  ingest: vi.fn(),
  listIngested: vi.fn(),
}));

import { analyzeNumericFields } from "../src/tools/analyzeNumericFields.js";

const toolOpts = { toolCallId: "test", messages: [] };

describe("analyzeNumericFields tool", () => {
  it("outlier_detection preserves OutlierFlag.methods on each flagged party", async () => {
    const out = await analyzeNumericFields.execute!(
      {
        operation: "outlier_detection",
        identifierValue: "100",
        n: 5,
      },
      toolOpts,
    );

    expect(out.operation).toBe("outlier_detection");
    expect(out.results).toHaveLength(1);
    expect(out.results[0]).toMatchObject({
      party: "Gamma",
      amount: 500,
      deviation: "high",
      methods: ["iqr", "mad", "ratio_to_min"],
    });
  });
});

import { tool } from "ai";
import { z } from "zod";
import { search } from "../store/vectorStore.js";
import type { CsvChunk, PdfChunk } from "../types.js";

export const searchDocuments = tool({
  description:
    "Search ingested CSV and PDF chunks via hybrid BM25 + vector retrieval. " +
    "Returns ranked matches with per-chunk confidence, groundedness, and caveats. " +
    "Use this when the user asks anything fact-specific about ingested data.",
  parameters: z.object({
    query: z.string().describe("Natural-language search query."),
    source: z
      .enum(["csv", "pdf", "both"])
      .default("both")
      .describe("Restrict search to CSV chunks, PDF chunks, or both."),
    topK: z
      .number()
      .int()
      .positive()
      .default(10)
      .describe("Maximum number of results to return."),
    minQualityScore: z
      .number()
      .min(0)
      .max(1)
      .default(0)
      .describe("Drop chunks with qualityScore below this threshold."),
  }),
  execute: async ({ query, source, topK, minQualityScore }) => {
    const results = await search(query, { source, topK, minQualityScore });

    return {
      results: results.map((r) => {
        const base = {
          id: r.chunk.id,
          source: r.chunk.source,
          document: r.chunk.document,
          score: r.score,
          groundedness: r.chunk.metadata.groundedness,
          confidence: r.chunk.metadata.confidence,
          qualityScore: r.chunk.metadata.qualityScore,
        };
        if (r.chunk.source === "csv") {
          const m = r.chunk.metadata as CsvChunk;
          return {
            ...base,
            outliers: m.outliers,
            caveats: m.caveats,
          };
        }
        const m = r.chunk.metadata as PdfChunk;
        return {
          ...base,
          pageNum: m.pageNum,
          method: m.method,
          warnings: m.warnings,
        };
      }),
    };
  },
});

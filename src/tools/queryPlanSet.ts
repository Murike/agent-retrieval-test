import { tool } from "ai";
import { z } from "zod";
import { search } from "../store/vectorStore.js";
import type { PdfChunk } from "../types.js";

const HIGH_CONFIDENCE_THRESHOLD = 0.8;

export const queryPlanSet = tool({
  description:
    "PDF-only retrieval over ingested plan sheets, specs, and drawings. " +
    "Use this when the user asks about plans, drawings, specifications, or any page-level PDF content.",
  parameters: z.object({
    topic: z.string().describe("Topic or question to look up in PDFs."),
    requireHighConfidence: z
      .boolean()
      .default(false)
      .describe(
        "When true, drop chunks with confidence below 0.8 (text-layer pages or strong OCR only).",
      ),
  }),
  execute: async ({ topic, requireHighConfidence }) => {
    const raw = await search(topic, { source: "pdf", topK: 5 });
    const filtered = requireHighConfidence
      ? raw.filter((r) => r.chunk.metadata.confidence >= HIGH_CONFIDENCE_THRESHOLD)
      : raw;

    const results = filtered.map((r) => {
      const m = r.chunk.metadata as PdfChunk;
      return {
        id: r.chunk.id,
        pageNum: m.pageNum,
        text: m.text,
        method: m.method,
        confidence: m.confidence,
        qualityScore: m.qualityScore,
        groundedness: m.groundedness,
        warnings: m.warnings,
        score: r.score,
      };
    });

    const caveats: string[] = [];
    if (raw.length === 0) {
      caveats.push("No PDF chunks matched the topic.");
    } else if (requireHighConfidence && results.length === 0) {
      caveats.push(
        "No high-confidence PDF text available for this topic; consider re-running with requireHighConfidence=false.",
      );
    }

    return { results, caveats };
  },
});

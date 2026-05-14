import { tool } from "ai";
import { z } from "zod";
import { ingest } from "../ingestion/ingestor.js";

export const ingestFile = tool({
  description:
    "Ingest a CSV or PDF file from a local path into the searchable chunk store. " +
    "Use this when the user asks to load, ingest, or import a file. " +
    "Returns the file record and any caveats from ingestion (unmapped columns, zero-value price columns, low-confidence OCR pages, etc.).",
  parameters: z.object({
    path: z.string().describe("Local filesystem path to a .csv or .pdf file."),
  }),
  execute: async ({ path }) => {
    const { file, caveats } = await ingest(path);
    return {
      path: file.path,
      type: file.type,
      chunkCount: file.chunkCount,
      ingestedAt: file.ingestedAt.toISOString(),
      caveats,
    };
  },
});

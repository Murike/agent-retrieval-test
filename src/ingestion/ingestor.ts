import path from "node:path";
import type { CsvChunk, IngestedFile, StoredChunk } from "../types.js";
import { ingestCsv } from "./csvIngestor.js";
import { ingestPdf } from "./pdfIngestor.js";
import { addChunks } from "../store/vectorStore.js";

const ingestedFiles: IngestedFile[] = [];
const csvChunks: CsvChunk[] = [];

function detectType(filePath: string): "csv" | "pdf" {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".pdf") return "pdf";
  throw new Error(
    `Unsupported file type: "${ext || filePath}" (only .csv and .pdf are supported)`,
  );
}

export interface IngestionResult {
  file: IngestedFile;
  caveats: string[];
}

export async function ingest(filePath: string): Promise<IngestionResult> {
  const type = detectType(filePath);
  let chunkCount = 0;
  const caveats: string[] = [];

  if (type === "csv") {
    const chunks = await ingestCsv(filePath);
    csvChunks.push(...chunks);
    const stored: StoredChunk[] = chunks.map((c) => ({
      id: c.id,
      source: "csv",
      document: c.summary,
      metadata: c,
    }));
    await addChunks(stored);
    chunkCount = chunks.length;
    for (const c of chunks) caveats.push(...c.caveats);
  } else {
    const chunks = await ingestPdf(filePath);
    const stored: StoredChunk[] = chunks.map((c) => ({
      id: c.id,
      source: "pdf",
      document: c.text,
      metadata: c,
    }));
    await addChunks(stored);
    chunkCount = chunks.length;
    for (const c of chunks) caveats.push(...c.warnings);
  }

  const file: IngestedFile = {
    path: filePath,
    type,
    chunkCount,
    ingestedAt: new Date(),
  };
  ingestedFiles.push(file);
  return { file, caveats: Array.from(new Set(caveats)) };
}

export function listIngested(): IngestedFile[] {
  return [...ingestedFiles];
}

export function getAllCsvChunks(): CsvChunk[] {
  return [...csvChunks];
}

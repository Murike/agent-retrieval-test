import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalIndex } from "vectra";
import { embed, embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import bm25Factory from "wink-bm25-text-search";
import type { StoredChunk, SearchResult } from "../types.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const RRF_K = 60;

// Vectra writes its index to a folder. Pointing it at a per-process tmpdir
// gives effectively in-memory semantics: no server, no persistence across runs.
const indexDir = mkdtempSync(join(tmpdir(), "project-embed-v2-"));
process.on("exit", () => {
  try {
    rmSync(indexDir, { recursive: true, force: true });
  } catch {
    // best effort
  }
});

const localChunks = new Map<string, StoredChunk>();
let vectraIndex: LocalIndex | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let bm25Engine: any = null;
let bm25Dirty = true;

async function getIndex(): Promise<LocalIndex> {
  if (vectraIndex) return vectraIndex;
  const index = new LocalIndex(indexDir);
  if (!(await index.isIndexCreated())) await index.createIndex();
  vectraIndex = index;
  return index;
}

// OpenAI's embeddings API rejects empty strings. PDF chunks for blank pages
// (or pages with no text layer when canvas/OCR isn't available) can have
// empty `document`. Substitute a placeholder so the embed call succeeds;
// the chunk's full metadata is preserved and BM25 simply won't match it.
function embeddableText(c: StoredChunk): string {
  const t = c.document?.trim();
  if (t) return t;
  return c.source === "pdf"
    ? `[no extractable text on page ${(c.metadata as { pageNum?: number }).pageNum ?? "?"}]`
    : "[empty document]";
}

// vectra's beginUpdate/endUpdate transaction is non-reentrant. The agent
// may dispatch ingestFile calls in parallel, so we serialize addChunks
// behind a single promise chain.
let writeQueue: Promise<void> = Promise.resolve();

export async function addChunks(chunks: StoredChunk[]): Promise<void> {
  if (chunks.length === 0) return;

  const run = async (): Promise<void> => {
    const { embeddings } = await embedMany({
      model: openai.embedding(EMBEDDING_MODEL),
      values: chunks.map(embeddableText),
    });

    const index = await getIndex();
    await index.beginUpdate();
    try {
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i];
        await index.insertItem({
          id: c.id,
          vector: embeddings[i],
          metadata: {
            source: c.source,
            qualityScore: c.metadata.qualityScore,
          },
        });
      }
    } finally {
      await index.endUpdate();
    }

    for (const c of chunks) localChunks.set(c.id, c);
    bm25Dirty = true;
  };

  // Chain onto the queue, but isolate failures so one bad call doesn't
  // poison subsequent ones.
  const next = writeQueue.then(run, run);
  writeQueue = next.catch(() => undefined);
  return next;
}

// wink-bm25 requires `consolidate()` before search and does not allow adding
// docs after consolidation, so we rebuild lazily whenever the store changed.
function rebuildBm25(): void {
  const engine = bm25Factory();
  engine.defineConfig({ fldWeights: { body: 1 } });
  engine.definePrepTasks([
    (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [],
  ]);
  for (const [id, c] of localChunks) {
    engine.addDoc({ body: c.document }, id);
  }
  engine.consolidate();
  bm25Engine = engine;
  bm25Dirty = false;
}

export interface SearchOpts {
  source?: "csv" | "pdf" | "both";
  topK?: number;
  minQualityScore?: number;
}

export async function search(
  query: string,
  opts: SearchOpts = {},
): Promise<SearchResult[]> {
  if (localChunks.size === 0) return [];

  const topK = opts.topK ?? 5;
  const source = opts.source ?? "both";
  const minQ = opts.minQualityScore ?? 0;

  if (bm25Dirty) rebuildBm25();

  // BM25 ranked list — array of [id, score].
  const bm25Raw = bm25Engine.search(query) as Array<[string, number]>;
  const bm25Ranks = new Map<string, number>();
  bm25Raw.forEach(([id], idx) => bm25Ranks.set(id, idx + 1));

  // Vector ranked list from vectra.
  const { embedding: queryVector } = await embed({
    model: openai.embedding(EMBEDDING_MODEL),
    value: query,
  });
  const index = await getIndex();
  const nResults = Math.min(localChunks.size, Math.max(topK * 4, 10));
  const vectorRes = await index.queryItems(queryVector, "", nResults);
  const vectorRanks = new Map<string, number>();
  vectorRes.forEach((r, idx) => vectorRanks.set(r.item.id, idx + 1));

  // Reciprocal rank fusion.
  const allIds = new Set<string>([
    ...bm25Ranks.keys(),
    ...vectorRanks.keys(),
  ]);
  const fused: Array<{ id: string; score: number }> = [];
  for (const id of allIds) {
    const b = bm25Ranks.get(id);
    const v = vectorRanks.get(id);
    const score =
      (b ? 1 / (RRF_K + b) : 0) + (v ? 1 / (RRF_K + v) : 0);
    fused.push({ id, score });
  }
  fused.sort((a, b) => b.score - a.score);

  // Materialize + filter, stop once we have topK.
  const results: SearchResult[] = [];
  for (const { id, score } of fused) {
    const chunk = localChunks.get(id);
    if (!chunk) continue;
    if (source !== "both" && chunk.source !== source) continue;
    if (chunk.metadata.qualityScore < minQ) continue;
    results.push({ chunk, score });
    if (results.length >= topK) break;
  }
  return results;
}

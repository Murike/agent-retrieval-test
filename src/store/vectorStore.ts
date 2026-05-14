import { embed, embedMany } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  create,
  insertMultiple,
  search as oramaSearch,
} from "@orama/orama";
import type { StoredChunk, SearchResult } from "../types.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
// text-embedding-3-small produces 1536-d vectors. Orama bakes the dimension
// into the schema at create() time, so changing the embedding model requires
// updating this constant.
const EMBEDDING_DIM = 1536;

const schema = {
  id: "string",
  body: "string",
  source: "enum",
  qualityScore: "number",
  embedding: `vector[${EMBEDDING_DIM}]`,
} as const;

type Db = ReturnType<typeof create<typeof schema>>;

// Orama stores its own copy of each document but type-erases the metadata
// union (CsvChunk | PdfChunk). The sidecar Map keeps the typed StoredChunk
// so SearchResult.chunk preserves its narrow type for downstream consumers.
const localChunks = new Map<string, StoredChunk>();
let db: Db | null = null;

function getDb(): Db {
  if (db) return db;
  db = create({
    schema,
    components: {
      // Match the previous wink-bm25 tokenizer so retrieval behavior on
      // identifier-heavy text (item numbers, project IDs) is unchanged.
      tokenizer: {
        language: "english",
        normalizationCache: new Map<string, string>(),
        tokenize: (raw: string): string[] =>
          raw.toLowerCase().match(/[a-z0-9]+/g) ?? [],
      },
    },
  });
  return db;
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

export async function addChunks(chunks: StoredChunk[]): Promise<void> {
  if (chunks.length === 0) return;

  const { embeddings } = await embedMany({
    model: openai.embedding(EMBEDDING_MODEL),
    values: chunks.map(embeddableText),
  });

  await insertMultiple(
    getDb(),
    chunks.map((c, i) => ({
      id: c.id,
      body: c.document,
      source: c.source,
      qualityScore: c.metadata.qualityScore,
      embedding: embeddings[i],
    })),
  );

  for (const c of chunks) localChunks.set(c.id, c);
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

  const { embedding: queryVector } = await embed({
    model: openai.embedding(EMBEDDING_MODEL),
    value: query,
  });

  const res = await oramaSearch(getDb(), {
    mode: "hybrid",
    term: query,
    vector: { value: queryVector, property: "embedding" },
    // Default similarity (0.8) discards anything mildly off-topic; lowering
    // it lets the BM25 side carry results that vectors alone would drop.
    similarity: 0,
    hybridWeights: { text: 0.5, vector: 0.5 },
    limit: topK,
    where: {
      ...(source !== "both" ? { source: { eq: source } } : {}),
      ...(minQ > 0 ? { qualityScore: { gte: minQ } } : {}),
    },
  });

  const results: SearchResult[] = [];
  for (const hit of res.hits) {
    const chunk = localChunks.get(String(hit.id));
    if (!chunk) continue;
    results.push({ chunk, score: hit.score });
  }
  return results;
}

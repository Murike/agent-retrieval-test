# CSV + PDF RAG Agent

TypeScript CLI that ingests CSV and PDF files, indexes them for hybrid retrieval (BM25 + dense vectors), and answers natural-language questions through an LLM tool loop. Every answer carries explicit `confidence`, `grounded_in_context`, `data_caveats`, and `sources`. Example data is construction bid tabulation, but the system makes as few domain-specific assumptions as possible — CSV headers are resolved to semantic roles at ingestion time so the same agent works on any CSV.

## Quickstart

```bash
npm install
cp .env.example .env && $EDITOR .env   # set OPENAI_API_KEY
npm run dev                            # starts the REPL
```

`npm test` runs the vitest suite. `npm run build` produces a JS build in `dist/`; `npm start` runs it. Node ≥ 20 required.

### Recommended: install `ocrmypdf` for fast OCR

PDF pages without a usable text layer are OCR'd. The fast path shells out to `ocrmypdf`:

- Linux: `sudo apt install -y ocrmypdf`
- macOS: `brew install ocrmypdf`

Without it, the system falls back to a pure-Node pipeline (`pdf-to-img` + `tesseract.js`) — slower but no system deps.

## REPL

```
/help              show commands         /ingest <path>     ingest a CSV or PDF
/quit              exit                  /reset             clear chat history
/files             list ingested files   /history           show message count
<free text>        ask the agent
```

Ingest can also be done using natural language, pulling more files at once.

## Architecture

```
src/
├── types.ts                     — Shared contracts (CsvChunk, PdfChunk, AgentAnswer, FieldRole, …)
├── chunking/
│   ├── config.ts                — Single source of truth for chunk-size parameters
│   ├── csv.ts                   — groupByIdentifier / groupByRowWindow
│   └── pdf.ts                   — splitPageText (intra-page overlap windowing)
├── ingestion/
│   ├── columnMapper.ts          — Two-tier (synonym → LLM) header → semantic-role mapping
│   ├── outliers.ts              — IQR + MAD + ratio-to-min over party amounts
│   ├── csvIngestor.ts           — Parse → role-map → validate → chunk → flag outliers
│   ├── pdfIngestor.ts           — Text-layer extraction; ocrmypdf primary, pdf-to-img fallback
│   └── ingestor.ts              — Dispatcher + in-memory file registry
├── schema/csvRow.ts             — Zod row schema built from column mappings (numeric ← role)
├── store/vectorStore.ts         — Orama in-memory hybrid index (BM25 + dense vectors)
├── tools/
│   ├── searchDocuments.ts       — Hybrid retrieval over CSV + PDF chunks
│   ├── analyzeNumericFields.ts  — top_n_groups | outlier_detection | summarize | compare_parties
│   ├── queryPdf.ts              — PDF-only retrieval with confidence gating
│   ├── compare.ts               — Deterministic max/min/sort over values from prior turns
│   └── ingestFile.ts            — File ingestion exposed as a tool
├── chat/history.ts              — Conversation history wrapper (CoreMessage[])
├── agent/
│   ├── systemPrompt.ts          — Tool-use contract, reference-resolution rules, AgentAnswer JSON shape
│   └── agent.ts                 — Vercel AI SDK generateText loop, history-aware
├── repl/repl.ts                 — node:repl with eval hook
└── index.ts                     — dotenv + env validation + REPL bootstrap
```

## Key decisions

### Chunking strategy

All parameters and grouping/splitting logic live under `src/chunking/`. Strategy is picked by data shape:

**CSV — chunk = group of rows sharing identifier values.** Headers are mapped to semantic roles (`identifier`, `label`, `price`, `amount`, `quantity`, `party`, `rank`, `unit`, `date`, `location`) by a two-tier resolver: a synonym table first (that assumes previously known and expected domain data), then `gpt-4o-mini` for what's left, with the canonical registry as context. Rows are grouped by the *concatenation of identifier-role column values* (e.g., `PROJ_ID::ITEM_NO`) — one chunk holds all rows for one identifier tuple. This makes "all bidders for this item" the retrieval unit and lets outlier detection run at ingest with every party present. Fallback for CSVs without identifier columns: fixed-row windows of `CSV_MAX_ROWS_PER_CHUNK = 100` rows. 100 was picked because it is large enough to be a semantically coherent section of the file but small enough that each chunk's embedded summary stays in the low-thousands of characters — cheap to embed, sharp for retrieval, and avoids fragmenting a 50k-row file into thousands of micro-chunks that would all compete for top-K slots.

**PDF — chunk = page (or overlapping window of a page).** Page boundary is preserved so `sources[].reference` cites a page. Within a page, text > `PDF_MAX_CHARS_PER_CHUNK = 2000` chars is split into windows with `PDF_OVERLAP_CHARS = 200` chars of overlap. 2000 chars (≈ 500 tokens at ~4 chars/token) is the standard target window for general-purpose retrieval chunks: `text-embedding-3-small` accepts up to 8191 tokens, but smaller windows give sharper topic focus per chunk and avoid burying a specific callout inside a wall of surrounding text. The 200-char (10%) overlap preserves sentence and phrase continuity across split boundaries — without it, a sentence straddling a cut would land split across two chunks with each half losing context; with 10% overlap, that sentence appears intact in at least one chunk. All emission paths (text-layer, ocrmypdf, pdf-to-img fallback, failed-OCR shim) route through one `makePdfChunks` helper so splitting is uniform.

### Hybrid retrieval (BM25 + dense vectors)

Single in-memory Orama index over `text-embedding-3-small` (1536-d) embeddings + BM25 with a custom alphanumeric tokenizer (`/[a-z0-9]+/g`). 50/50 hybrid weights, similarity threshold 0 so BM25 keeps results dense vectors would discard. CSV identifiers like `6271074` need BM25; PDF prose needs vectors; running both eliminates the trade-off. `source` and `qualityScore` filters are pushed into the index via `where` rather than post-filtered.

### Deviation detection

`src/ingestion/outliers.ts` runs three methods over party amounts per group at ingest time: IQR fence, modified Z-score (MAD), and ratio-to-minimum. A registry is flagged if *any* method tags it, and the list of methods is preserved on the chunk. The system prompt requires the agent to quote the methods in answers (e.g., "Acme at $93.90/ton — flagged by iqr and ratio_to_min — 36% below median"). Surfaced explicitly via `analyzeNumericFields` with `operation: "outlier_detection"`.

### Tool surface — agent as orchestrator

Capabilities are exposed as five tools with Zod parameter schemas — `ingestFile`, `searchDocuments`, `analyzeNumericFields`, `queryPdf`, `compare`. The agent runs the Vercel AI SDK `generateText` loop with `maxSteps: 10`; there is no hand-rolled orchestration or regex pre-routing — even "please ingest this file" goes to the LLM, which calls `ingestFile`. The final answer is a strict JSON shape (`AgentAnswer`) validated with Zod after the loop terminates.

### Conversation continuity

`src/chat/history.ts` holds the `CoreMessage[]` across turns. The per-turn "currently ingested files / CSV columns" preamble is concatenated onto `system:` (rebuilt each turn) rather than baked into user messages, so prior turns stay clean and the model can resolve back-references like "those items". For comparative/aggregate questions over a prior enumerated list, the system prompt routes the model to the deterministic `compare` tool rather than letting it do arithmetic in prose — fixes a known LLM weakness on max/min/comparison over numbers in text.

### Other choices, briefly

- **Two-tier column mapping** keeps the common path deterministic (synonyms, `confidence: 1.0`) and uses the LLM only as a fallback, with each mapping's `tier` and `confidence` propagated as caveats so the data is auditable.
- **`@orama/orama`** gives BM25 + vector fusion in one native-TS engine — no server, no native bindings, no migration story.
- **No persistence by design** — single-session CLI; persistence adds freshness/migration costs not warranted by the assignment scope.
- **No DI containers, no repository wrappers.** Tests mock at module boundaries with `vi.mock`.

## Areas of improvement

- **Adaptive hybrid weights** — bump BM25 when the query has long digit runs (`/\d{4,}/`); bump vector for prose.
- **Cross-page PDF re-chunking** — current splitter is intra-page only; paragraph-aware chunks spanning pages (with `pageRange: [start, end]`) would help long flowing specs.
- **Cap oversized identifier groups** — today a 500-bidder group becomes one large chunk.
- **Improved LLM enrichment of data** — A few extra calls to a model could help improve semantic context of the ingested data as a whole, making it more robust for unkown files.
- **Cross-file normalization** — unit conversion, currency, scale alignment when comparing values across CSVs.

## Limitations

- **In-memory only** — chunks, registry, and Orama index reset on each process start.
- **Header-mapping LLM is non-deterministic** — same file with unusual headers may produce slightly different mappings between runs. `tier` + `confidence` make it auditable.
- **OCR is best-effort** on drawing-heavy plan sets; surfaced as `confidence` / `warnings`, never silently dropped.
- **No cross-file normalization** (units, currency, scale).

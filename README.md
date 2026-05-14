# CSV + PDF RAG Agent

A small TypeScript CLI that ingests CSV and PDF files, maps CSV columns to semantic roles, indexes everything for hybrid retrieval, and answers natural-language questions through an LLM tool loop. Every answer carries explicit confidence, groundedness, caveats, and source references. The example data in this repo is construction-bid data, but the system makes no domain-specific assumptions about CSV content.

## How to run

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# edit .env and set OPENAI_API_KEY

# 3. Start the REPL
npm run dev
```

`npm run build` produces a JavaScript build in `dist/`; `npm start` runs it. `npm test` runs the vitest suite. `npm run typecheck` runs `tsc --noEmit`.

### Optional: `canvas` for PDF OCR

`canvas` (used to rasterize PDF pages for the OCR fallback on scanned PDFs) is a native module and is declared as an **optional dependency**. If its build fails, `npm install` will still succeed and the rest of the system works normally — PDF pages without a text layer will be emitted as low-confidence chunks with a warning instead of being OCR'd.

To enable OCR, install the system libraries and reinstall:

- Linux: `sudo apt install -y libpixman-1-dev libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev build-essential`
- macOS: `brew install pkg-config cairo pango libpng jpeg giflib librsvg pixman`

Then `npm install` again — `canvas` will build and OCR will work end-to-end.

## Environment variables

| Variable         | Required | Purpose                                                          |
|------------------|----------|------------------------------------------------------------------|
| `OPENAI_API_KEY` | yes      | Used for `gpt-4o`, `gpt-4o-mini`, and `text-embedding-3-small`.  |

## REPL commands

```
> /help
Commands:
  /help              show this help
  /quit              exit
  /files             list ingested files
  /ingest <path>     ingest a CSV or PDF file
  <free text>        ask the agent a question

> /ingest ./data/bids.csv
Ingested ./data/bids.csv [csv] — 42 chunks.
Caveats:
  - Engineer estimate of unit price is zero
  - Unmapped columns: REGION

> Who has the lowest unit price for ITEM 4040350 in project 0676350?
{
  "answer": "Blythe Construction at $93.90 per ton (lowest of 3 rows).",
  "confidence": "high",
  "grounded_in_context": true,
  "data_caveats": [],
  "sources": [
    { "type": "csv_row", "reference": "csv::bids.csv::0676350::4040350" }
  ]
}

> Please ingest ./data/plans.pdf and summarize any drainage callouts.
# The agent calls ingestFile, then queryPdf, then returns the structured JSON answer.
```

Slash commands are handled by the REPL directly. Any non-slash input is sent to the agent — there is no regex pre-routing to guess ingestion intent. If the user asks the agent in plain English to ingest a file, the agent invokes the `ingestFile` tool.

### A non-bid example

The same agent works on any CSV whose columns map to the canonical semantic roles. For a sales-order CSV with headers `customer_id, product, qty, unit_price, total`, the same question shape works:

```
> /ingest ./data/orders.csv
Ingested ./data/orders.csv [csv] — 18 chunks.

> Who has the highest unit price for product SKU-1042?
{
  "answer": "Acme Corp at $42.50 per unit (3 orders).",
  "confidence": "high",
  "grounded_in_context": true,
  "data_caveats": [],
  "sources": [
    { "type": "csv_row", "reference": "csv::orders.csv::SKU-1042" }
  ]
}
```

No code change is required — `customer_id` and `product` both resolve to the `identifier` role, `qty` to `quantity`, `unit_price` to `price`, `total` to `amount`. The tools (`analyzeNumericFields`, `searchDocuments`) read those roles instead of hard-coded field names.

## Architecture

```
src/
├── types.ts                     — Shared contracts (CsvChunk, PdfChunk, AgentAnswer, FieldRole, …)
├── schema/csvRow.ts             — Dynamic Zod row schema built from column mappings (numeric ← role)
├── ingestion/
│   ├── columnMapper.ts          — Two-tier (synonym → LLM) mapping over the CanonicalField registry
│   ├── outliers.ts              — IQR + MAD + ratio-to-min outlier detection (party + amount)
│   ├── csvIngestor.ts           — Parse → role-map → validate → group by identifiers → summarize → flag
│   ├── pdfIngestor.ts           — Text-layer extraction, Tesseract OCR fallback
│   └── ingestor.ts              — Dispatcher + in-memory registry
├── store/vectorStore.ts         — vectra (in-memory) + wink-bm25 + reciprocal rank fusion
├── tools/
│   ├── searchDocuments.ts       — Hybrid retrieval over CSV + PDF chunks
│   ├── analyzeNumericFields.ts  — top_n_by_amount, outlier_detection, summarize, compare_parties
│   ├── queryPdf.ts              — PDF-only retrieval with confidence gating
│   └── ingestFile.ts            — File ingestion exposed as a tool
├── agent/
│   ├── systemPrompt.ts          — Tool-use-first prompt with AgentAnswer JSON contract
│   └── agent.ts                 — generateText loop with the four tools + runtime schema preface
├── repl/repl.ts                 — node:repl with eval hook
└── index.ts                     — dotenv + env validation + REPL bootstrap
```

Layer responsibilities, in one line each:

- **types**: stable contracts shared across modules.
- **schema**: runtime validation built after column mapping.
- **ingestion**: file → typed chunks, including outliers and confidence.
- **store**: write + search over chunks (vectra vectors, BM25 keywords, RRF merge).
- **tools**: LLM-facing capabilities — small parameter schemas, predictable outputs.
- **agent**: configures the LLM tool loop and injects the current CSV schema into the prompt; no domain logic.
- **repl**: user interaction only; no orchestration.

## Key decisions

- **Vercel AI SDK for the tool loop.** `generateText` with `tools` already implements the iterate-with-tool-calls loop. No need to hand-roll an orchestration loop, no prompt-engineering tricks to invoke tools. `maxSteps: 10` is the only guardrail.
- **`vectra` for vector storage.** Pure-JS local index with no server and no native bindings. The index lives in a per-process `os.tmpdir()` folder that is cleaned up on exit, giving effectively in-memory semantics. Embeddings are computed with OpenAI `text-embedding-3-small` and inserted explicitly. Brute-force cosine is fine at the scale of a single-session CLI; LanceDB or a hosted vector DB would be the next step up.
- **Hybrid BM25 + vector with reciprocal rank fusion.** Vector search alone misses literal identifiers (item numbers, customer IDs); BM25 alone misses paraphrases. RRF with `k=60` is the standard, parameter-light way to merge them.
- **Two-tier column mapping (synonym → LLM) over a semantic role registry.** Real CSVs come in countless header dialects. A `CanonicalField` registry pairs each canonical name with a semantic role (`identifier`, `label`, `amount`, `price`, `quantity`, `unit`, `date`, `party`, `rank`, `extra`) and a list of synonyms. The deterministic synonym table handles the common cases at confidence 1.0; `gpt-4o-mini` handles the rest with an explicit confidence score and the role/label registry as context. Every mapping carries its role into downstream chunks so the ingestor, tools, and agent prompt can operate generically rather than on hard-coded field names.
- **Explicit confidence and caveats on every chunk.** Both CSV and PDF chunks carry `qualityScore`, `confidence`, `groundedness`, and `caveats`/`warnings`. The agent's system prompt requires these to flow through to the final `AgentAnswer`.
- **`node:repl` for the interface.** Built-in, no CLI framework dependency. Slash commands dispatched in the `eval` hook; everything else goes to the agent.
- **No caching by design.** Caching would add a third write path and a freshness story. For a single-session CLI those costs aren't worth it.
- **Simple production code over test-oriented indirection.** No DI containers, no repository wrappers, no registries that only exist to swap implementations in tests. Tests use `vi.mock` at module boundaries instead.
- **Minimal typing.** Only the data contracts that cross module boundaries live in `types.ts`. No generic provenance wrappers, no aliases for two-string unions.

## Limitations

- **In-memory state.** Chunks, the CSV registry, the BM25 index, and the vectra index all reset on every process restart. There is no persistence layer.
- **Brute-force vector search.** vectra scans every vector on each query. Fine for thousands of chunks; would need an ANN index past tens of thousands.
- **OCR fallback is coarse.** It renders each page at 2× scale and runs Tesseract. Image-heavy or drawing-style PDFs are notoriously hard to OCR; expect low confidence on those, surfaced as a warning.
- **No re-ranking.** RRF gives a sensible default; a learned re-ranker would do better but is out of scope.
- **Header-mapping LLM is non-deterministic.** Tier-2 mapping calls a real LLM. Two runs over the same file with unusual headers may produce slightly different mappings. The `tier` and `confidence` fields make this auditable.
- **Cross-file normalization (e.g., unit conversion, currency, scale) is not done.** If two CSVs use different units or scales for the same identifier, they are stored as-is. Downstream comparisons may be off.
- **Schema inference is shallow.** Numeric detection is driven by the canonical role (`price`/`amount`/`quantity`/`rank`); columns that fall outside the registry are kept as strings.
- **REPL file management is minimal.** `/files` lists; there is no `/forget`, no per-file inspection, no chunk dump.

## Future improvements

- Persistent vector store (point vectra at a stable folder, or swap to LanceDB / a managed vector DB).
- A learned re-ranker over the top RRF candidates.
- Better OCR for image-heavy PDFs (page segmentation, table extraction, layout-aware models).
- Cross-file normalization (unit conversion, deflation, geographic adjustment).
- Stronger schema inference: data-driven numeric detection, unit recognition, type coercion beyond `z.coerce.number()`.
- Richer file management in the REPL: `/inspect <path>`, `/forget <path>`, chunk previews.
- Smarter outlier rationales surfaced to the agent (e.g. "Gamma at $500 is 4.5× the median").

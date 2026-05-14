// Single source of truth for chunking parameters. Every decision about chunk
// size in the ingestion pipeline reads from this file. If you need to change
// behavior, change it here — the helpers in src/chunking/{csv,pdf}.ts have
// no other knobs.

// CSV: how many rows per chunk when the file has no identifier columns to
// group on. Bid-style CSVs (with PROJ_ID + ITEM_NO) ignore this and chunk
// by identifier tuple; generic CSVs fall back to fixed-row windows.
// 100 rows keeps the embedded summary in the low-thousands of characters
// and gives retrieval enough chunks to discriminate among, without
// fragmenting a file into hundreds of micro-chunks.
export const CSV_MAX_ROWS_PER_CHUNK = 100;

// PDF: target maximum characters per chunk after page extraction. A page
// whose text exceeds this is split into overlapping windows. At ~4 chars
// per token this is ~500 tokens — the standard target for general-purpose
// retrieval chunks. Smaller windows give sharper retrieval; larger windows
// preserve more local context.
export const PDF_MAX_CHARS_PER_CHUNK = 2000;

// PDF: overlap between consecutive windows when a page is split. 10% of
// the window size preserves sentence/phrase continuity across split
// boundaries without much duplication cost.
export const PDF_OVERLAP_CHARS = 200;

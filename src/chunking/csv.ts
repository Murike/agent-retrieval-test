import { CSV_MAX_ROWS_PER_CHUNK } from "./config.js";

export interface ChunkGroup<T> {
  // Values used to build the chunk id and any "grouped by" caption.
  // For identifier-based grouping these are the identifier column values
  // (e.g., ["5275280", "6271074"]); for row-window grouping they are
  // synthetic part markers (e.g., ["part0"]).
  identifierValues: string[];
  rows: T[];
}

// Bucket rows by the identifier-value tuple produced by `identifierValuesOf`.
// Used when the CSV has one or more identifier-role columns — each unique
// tuple becomes one chunk holding all rows that share it.
export function groupByIdentifier<T>(
  rows: T[],
  identifierValuesOf: (row: T) => string[],
): Map<string, ChunkGroup<T>> {
  const groups = new Map<string, ChunkGroup<T>>();
  for (const row of rows) {
    const identifierValues = identifierValuesOf(row);
    const key = identifierValues.join("::");
    let g = groups.get(key);
    if (!g) {
      g = { identifierValues, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(row);
  }
  return groups;
}

// Bucket rows into fixed-size windows. Used as the fallback when a CSV has
// no identifier-role columns — without this every such file would collapse
// to a single chunk regardless of row count.
export function groupByRowWindow<T>(
  rows: T[],
  maxRowsPerChunk: number = CSV_MAX_ROWS_PER_CHUNK,
): Map<string, ChunkGroup<T>> {
  const groups = new Map<string, ChunkGroup<T>>();
  if (rows.length === 0) return groups;

  for (let start = 0; start < rows.length; start += maxRowsPerChunk) {
    const window = rows.slice(start, start + maxRowsPerChunk);
    const partIndex = Math.floor(start / maxRowsPerChunk);
    const key = `part${partIndex}`;
    groups.set(key, { identifierValues: [key], rows: window });
  }
  return groups;
}

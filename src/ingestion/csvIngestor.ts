import { readFile } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import { mapColumns } from "./columnMapper.js";
import { buildRowSchema } from "../schema/csvRow.js";
import { detectOutliers } from "./outliers.js";
import type { ColumnMapping, CsvChunk, OutlierFlag } from "../types.js";

const NUMERIC_FIELDS = new Set([
  "QTY",
  "ENG_EST_UNIT_PR",
  "UNIT_PR",
  "EXT_AMT",
  "BID_RANK",
  "BID_TOTAL",
]);

interface RawRow {
  [key: string]: string;
}

interface ProcessedRow {
  row: Record<string, string>;
  caveats: string[];
  quality: number;
}

function remapRow(
  raw: RawRow,
  mappings: ColumnMapping[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of mappings) {
    const value = raw[m.originalHeader];
    out[m.mappedName] = value === undefined || value === null ? "" : String(value);
  }
  return out;
}

function processRow(
  raw: RawRow,
  mappings: ColumnMapping[],
  schema: ReturnType<typeof buildRowSchema>,
): ProcessedRow {
  const caveats: string[] = [];
  let quality = 1.0;

  const remapped = remapRow(raw, mappings);

  // Per-row caveats around numeric fields, before schema validation.
  for (const m of mappings) {
    if (m.tier === "unmapped") continue;
    if (!NUMERIC_FIELDS.has(m.mappedName)) continue;

    const value = remapped[m.mappedName];
    const parsed = value === "" ? NaN : Number(value);

    if (value === "" || Number.isNaN(parsed)) {
      caveats.push(`${m.mappedName} is empty or non-numeric`);
      quality -= 0.1;
      continue;
    }
    if (m.mappedName === "ENG_EST_UNIT_PR" && parsed === 0) {
      caveats.push("Engineer estimate unavailable");
      quality -= 0.05;
    }
  }

  // Mapping-tier caveats — LLM-mapped columns lower trust slightly.
  for (const m of mappings) {
    if (m.tier === "llm") {
      caveats.push(
        `Column "${m.originalHeader}" was LLM-mapped to ${m.mappedName} (confidence ${m.confidence.toFixed(2)})`,
      );
      quality -= 0.05;
    }
  }

  // Schema validation. Coerces numerics; failures degrade quality but don't reject the row.
  const result = schema.safeParse(remapped);
  if (!result.success) {
    caveats.push(`Schema validation issues: ${result.error.issues.length}`);
    quality -= 0.1;
  }

  if (quality < 0) quality = 0;

  return { row: remapped, caveats, quality };
}

function summarize(
  projId: string,
  itemNo: string,
  rows: Record<string, string>[],
): string {
  const desc = rows[0]?.ITEM_DESC ?? "(no description)";
  const unit = rows[0]?.UNIT ? ` (${rows[0].UNIT})` : "";
  const bids = rows
    .filter((r) => r.BIDDER && r.UNIT_PR)
    .map((r) => `${r.BIDDER} ($${r.UNIT_PR})`);
  const ranked = rows.find((r) => r.BID_RANK === "1");
  const rankLine = ranked?.BIDDER
    ? ` Rank 1 bidder: ${ranked.BIDDER}.`
    : "";

  const head = `ITEM ${itemNo} — ${desc}${unit}: ${rows.length} bids in project ${projId}.`;
  const bidsLine = bids.length > 0 ? ` Bidders: ${bids.join(", ")}.` : "";
  return head + bidsLine + rankLine;
}

export async function ingestCsv(filePath: string): Promise<CsvChunk[]> {
  const text = await readFile(filePath, "utf8");
  const parsed = Papa.parse<RawRow>(text, {
    header: true,
    skipEmptyLines: true,
  });

  const rawRows = parsed.data ?? [];
  if (rawRows.length === 0) return [];

  const rawHeaders = parsed.meta.fields ?? Object.keys(rawRows[0]);
  const { mappings, unmapped } = await mapColumns(rawHeaders);
  const schema = buildRowSchema(mappings);

  const processed: ProcessedRow[] = rawRows.map((r) =>
    processRow(r, mappings, schema),
  );

  // Group by PROJ_ID + ITEM_NO.
  const groups = new Map<
    string,
    { projId: string; itemNo: string; rows: ProcessedRow[] }
  >();
  for (const p of processed) {
    const projId = p.row.PROJ_ID ?? "";
    const itemNo = p.row.ITEM_NO ?? "";
    const key = `${projId}::${itemNo}`;
    let g = groups.get(key);
    if (!g) {
      g = { projId, itemNo, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(p);
  }

  const fileBase = path.basename(filePath);
  const chunks: CsvChunk[] = [];

  for (const [, group] of groups) {
    const rows = group.rows.map((r) => r.row);

    const bids = group.rows
      .map((r) => ({
        bidder: r.row.BIDDER ?? "",
        unitPr: Number(r.row.UNIT_PR),
      }))
      .filter((b) => b.bidder !== "" && Number.isFinite(b.unitPr));

    const outliers: OutlierFlag[] = detectOutliers(bids);

    const qualitySum = group.rows.reduce((acc, r) => acc + r.quality, 0);
    const qualityScore =
      group.rows.length > 0 ? qualitySum / group.rows.length : 0;

    const groupCaveats = Array.from(
      new Set(group.rows.flatMap((r) => r.caveats)),
    );
    if (unmapped.length > 0) {
      groupCaveats.push(`Unmapped columns: ${unmapped.join(", ")}`);
    }

    chunks.push({
      id: `csv::${fileBase}::${group.projId || "_"}::${group.itemNo || "_"}`,
      summary: summarize(group.projId, group.itemNo, rows),
      rows,
      columnMappings: mappings,
      outliers,
      qualityScore,
      groundedness: "direct",
      confidence: qualityScore,
      caveats: groupCaveats,
    });
  }

  return chunks;
}

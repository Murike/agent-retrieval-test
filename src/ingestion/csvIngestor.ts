import { readFile } from "node:fs/promises";
import path from "node:path";
import Papa from "papaparse";
import { mapColumns } from "./columnMapper.js";
import { buildRowSchema, isNumericRole } from "../schema/csvRow.js";
import { detectOutliers } from "./outliers.js";
import { groupByIdentifier, groupByRowWindow } from "../chunking/csv.js";
import type {
  ColumnMapping,
  CsvChunk,
  FieldRole,
  OutlierFlag,
} from "../types.js";

// Fraction of rows where this column carries usable signal. For numeric roles,
// a value is "live" if it parses to a finite non-zero number; for everything
// else, any non-empty string counts. Drives prioritizeMappings.
function livenessScore(
  mapping: ColumnMapping,
  rows: Record<string, string>[],
): number {
  if (rows.length === 0 || mapping.tier === "unmapped") return 0;
  const numeric = isNumericRole(mapping.role);
  let live = 0;
  for (const r of rows) {
    const v = r[mapping.mappedName];
    if (v === undefined || v === "") continue;
    if (numeric) {
      const n = Number(v);
      if (!Number.isFinite(n) || n === 0) continue;
    }
    live++;
  }
  return live / rows.length;
}

// When two columns share the same role (e.g. ENG_EST_UNIT_PR + UNIT_PR both
// role "price"), firstMappingByRole returns the first by header order — which
// can be the all-zero "estimate" sibling of the real column. Reorder within
// each role by descending liveness so the populated column wins; preserve the
// original cross-role positions so unrelated callers see the same layout.
function prioritizeMappings(
  mappings: ColumnMapping[],
  rows: Record<string, string>[],
): ColumnMapping[] {
  const byRole = new Map<FieldRole, ColumnMapping[]>();
  for (const m of mappings) {
    const arr = byRole.get(m.role);
    if (arr) arr.push(m);
    else byRole.set(m.role, [m]);
  }
  for (const [, arr] of byRole) {
    const scored = arr.map((m, i) => ({ m, i, live: livenessScore(m, rows) }));
    scored.sort((a, b) => b.live - a.live || a.i - b.i);
    arr.splice(0, arr.length, ...scored.map((s) => s.m));
  }
  const cursors = new Map<FieldRole, number>();
  return mappings.map((m) => {
    const arr = byRole.get(m.role)!;
    const i = cursors.get(m.role) ?? 0;
    cursors.set(m.role, i + 1);
    return arr[i];
  });
}

interface RawRow {
  [key: string]: string;
}

interface ProcessedRow {
  row: Record<string, string>;
  caveats: string[];
  quality: number;
}

function captionFor(m: ColumnMapping): string {
  return m.semanticLabel !== "" ? m.semanticLabel : m.mappedName;
}

function mappingsByRole(
  mappings: ColumnMapping[],
  role: FieldRole,
): ColumnMapping[] {
  return mappings.filter((m) => m.role === role && m.tier !== "unmapped");
}

function firstMappingByRole(
  mappings: ColumnMapping[],
  role: FieldRole,
): ColumnMapping | undefined {
  return mappingsByRole(mappings, role)[0];
}

function remapRow(
  raw: RawRow,
  mappings: ColumnMapping[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of mappings) {
    const value = raw[m.originalHeader];
    out[m.mappedName] =
      value === undefined || value === null ? "" : String(value);
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
    if (!isNumericRole(m.role)) continue;

    const value = remapped[m.mappedName];
    const parsed = value === "" ? NaN : Number(value);
    const caption = captionFor(m);

    if (value === "" || Number.isNaN(parsed)) {
      caveats.push(`${caption} is empty or non-numeric`);
      quality -= 0.1;
      continue;
    }
    if (m.role === "price" && parsed === 0) {
      caveats.push(`${caption} is zero`);
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
  mappings: ColumnMapping[],
  identifierColumns: ColumnMapping[],
  identifierValues: string[],
  rows: Record<string, string>[],
): string {
  const labelCol = firstMappingByRole(mappings, "label");
  const unitCol = firstMappingByRole(mappings, "unit");
  const partyCol = firstMappingByRole(mappings, "party");
  const priceCol = firstMappingByRole(mappings, "price");
  const rankCol = firstMappingByRole(mappings, "rank");

  const labelValue =
    labelCol && rows[0]?.[labelCol.mappedName]
      ? rows[0][labelCol.mappedName]
      : "(no label)";
  const unitValue =
    unitCol && rows[0]?.[unitCol.mappedName]
      ? rows[0][unitCol.mappedName]
      : "";
  const unitSuffix = unitValue ? ` (${unitValue})` : "";

  const header = `${labelValue}${unitSuffix}: ${rows.length} rows`;

  const idSegments: string[] = [];
  for (let i = 0; i < identifierColumns.length; i++) {
    const col = identifierColumns[i];
    const value = identifierValues[i];
    if (value) {
      idSegments.push(`${captionFor(col)}=${value}`);
    }
  }
  const groupedBy =
    idSegments.length > 0 ? ` grouped by ${idSegments.join(", ")}` : "";

  let body = "";
  if (partyCol && priceCol) {
    const pairs = rows
      .map((r) => ({
        party: r[partyCol.mappedName] ?? "",
        price: r[priceCol.mappedName] ?? "",
      }))
      .filter((p) => p.party !== "" && p.price !== "")
      .map((p) => `${p.party} at ${p.price}`);
    if (pairs.length > 0) {
      body = `. ${pairs.join(", ")}`;
    }
  }

  let topRank = "";
  if (rankCol && partyCol) {
    const top = rows.find((r) => r[rankCol.mappedName] === "1");
    const topParty = top?.[partyCol.mappedName];
    if (topParty) {
      topRank = `. Top rank: ${topParty}`;
    }
  }

  return `${header}${groupedBy}${body}${topRank}.`;
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
  const { mappings: rawMappings, unmapped } = await mapColumns(rawHeaders);
  const schema = buildRowSchema(rawMappings);

  const processed: ProcessedRow[] = rawRows.map((r) =>
    processRow(r, rawMappings, schema),
  );

  // Re-rank mappings within each role by how populated the column actually
  // is, so firstMappingByRole returns the column carrying signal when two
  // share a role (e.g. an estimate column next to the real price column).
  const mappings = prioritizeMappings(
    rawMappings,
    processed.map((p) => p.row),
  );

  // Chunking decision — see src/chunking/csv.ts and src/chunking/config.ts.
  // With identifier-role columns: one chunk per identifier tuple
  // (e.g., one chunk per PROJ_ID::ITEM_NO).
  // Without: fixed-row windows of CSV_MAX_ROWS_PER_CHUNK rows each.
  const identifierColumns = mappingsByRole(mappings, "identifier");
  const groups =
    identifierColumns.length === 0
      ? groupByRowWindow(processed)
      : groupByIdentifier(processed, (p) =>
          identifierColumns.map((c) => p.row[c.mappedName] ?? ""),
        );

  const fileBase = path.basename(filePath);
  const partyCol = firstMappingByRole(mappings, "party");
  const priceCol = firstMappingByRole(mappings, "price");
  const chunks: CsvChunk[] = [];

  for (const [, group] of groups) {
    const rows = group.rows.map((r) => r.row);

    let outliers: OutlierFlag[] = [];
    if (partyCol && priceCol) {
      const partyAmountRows: Array<{ party: string; amount: number }> =
        group.rows
          .map((r) => ({
            party: r.row[partyCol.mappedName] ?? "",
            amount: Number(r.row[priceCol.mappedName]),
          }))
          .filter((b) => b.party !== "" && Number.isFinite(b.amount));
      outliers = detectOutliers(partyAmountRows);
    }

    const qualitySum = group.rows.reduce((acc, r) => acc + r.quality, 0);
    const qualityScore =
      group.rows.length > 0 ? qualitySum / group.rows.length : 0;

    const groupCaveats = Array.from(
      new Set(group.rows.flatMap((r) => r.caveats)),
    );
    if (unmapped.length > 0) {
      groupCaveats.push(`Unmapped columns: ${unmapped.join(", ")}`);
    }

    const idSuffix =
      group.identifierValues.length > 0
        ? group.identifierValues.map((v) => v || "_").join("::")
        : "_";

    chunks.push({
      id: `csv::${fileBase}::${idSuffix}`,
      summary: summarize(mappings, identifierColumns, group.identifierValues, rows),
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

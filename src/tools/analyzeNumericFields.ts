import { tool } from "ai";
import { z } from "zod";
import { getAllCsvChunks } from "../ingestion/ingestor.js";
import type { ColumnMapping, CsvChunk, FieldRole } from "../types.js";

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

function identifierValuesForRow(
  mappings: ColumnMapping[],
  row: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of mappingsByRole(mappings, "identifier")) {
    out[m.mappedName] = row[m.mappedName] ?? "";
  }
  return out;
}

function labelForRow(
  mappings: ColumnMapping[],
  row: Record<string, string>,
): string {
  const labelCol = firstMappingByRole(mappings, "label");
  return labelCol ? (row[labelCol.mappedName] ?? "") : "";
}

function unitForRow(
  mappings: ColumnMapping[],
  row: Record<string, string>,
): string {
  const unitCol = firstMappingByRole(mappings, "unit");
  return unitCol ? (row[unitCol.mappedName] ?? "") : "";
}

function rowMatchesIdentifier(
  mappings: ColumnMapping[],
  row: Record<string, string>,
  identifierValue: string,
): boolean {
  for (const m of mappingsByRole(mappings, "identifier")) {
    if (row[m.mappedName] === identifierValue) return true;
  }
  return false;
}

function filterChunks(
  chunks: CsvChunk[],
  identifierValue: string | undefined,
): CsvChunk[] {
  if (!identifierValue) return chunks;
  return chunks.filter((c) => {
    const first = c.rows[0] ?? {};
    return rowMatchesIdentifier(c.columnMappings, first, identifierValue);
  });
}

function parseNum(v: string | undefined): number {
  if (v === undefined || v === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface NumericRow {
  party: string;
  amount: number;
  lineTotal: number;
  identifiers: Record<string, string>;
  label: string;
  unit: string;
}

function collectRows(chunks: CsvChunk[]): NumericRow[] {
  const out: NumericRow[] = [];
  for (const c of chunks) {
    const priceCol = firstMappingByRole(c.columnMappings, "price");
    const partyCol = firstMappingByRole(c.columnMappings, "party");
    const amountCol = firstMappingByRole(c.columnMappings, "amount");
    if (!priceCol || !partyCol) continue;
    for (const row of c.rows) {
      const amount = parseNum(row[priceCol.mappedName]);
      if (!Number.isFinite(amount)) continue;
      const party = row[partyCol.mappedName] ?? "";
      if (!party) continue;
      out.push({
        party,
        amount,
        lineTotal: amountCol ? parseNum(row[amountCol.mappedName]) : NaN,
        identifiers: identifierValuesForRow(c.columnMappings, row),
        label: labelForRow(c.columnMappings, row),
        unit: unitForRow(c.columnMappings, row),
      });
    }
  }
  return out;
}

export const analyzeNumericFields = tool({
  description:
    "Numeric analysis over ingested CSV data. " +
    "Use this for top-N groups, outlier listings, per-group summaries, " +
    "and party comparisons across any numeric (price/amount/quantity) columns.",
  parameters: z.object({
    operation: z
      .enum([
        "top_n_groups",
        "outlier_detection",
        "summarize",
        "compare_parties",
      ])
      .describe("Which analysis to run."),
    identifierValue: z
      .string()
      .optional()
      .describe(
        "Filter to rows where any identifier-role column equals this value.",
      ),
    n: z
      .number()
      .int()
      .positive()
      .default(5)
      .describe("How many groups to return for top_n_groups."),
    direction: z
      .enum(["asc", "desc"])
      .default("desc")
      .describe(
        "top_n_groups sort order: 'desc' = highest first (default, matches 'top'/'most'), 'asc' = lowest first.",
      ),
    aggregate: z
      .enum(["sum", "min", "max", "mean", "count"])
      .default("sum")
      .describe(
        "top_n_groups aggregation per group. Use 'min' for bid-style 'cost = winning (lowest) bid'. Use 'sum' for revenue/spend rollups. Use 'max' for 'highest unit price' style. Use 'mean' for averages. Use 'count' to rank groups by row count.",
      ),
    on: z
      .enum(["price", "amount", "quantity"])
      .default("amount")
      .describe(
        "top_n_groups: which numeric role to aggregate. 'amount' for line totals / revenue, 'price' for unit prices, 'quantity' for counts of stock.",
      ),
    parties: z
      .array(z.string())
      .optional()
      .describe("Party names to compare (compare_parties only)."),
  }),
  execute: async ({
    operation,
    identifierValue,
    n,
    direction,
    aggregate,
    on,
    parties,
  }) => {
    const all = getAllCsvChunks();
    const chunks = filterChunks(all, identifierValue);

    if (chunks.length === 0) {
      return {
        operation,
        results: [],
        caveats: ["No matching CSV chunks in memory for the given filters."],
      };
    }

    if (operation === "top_n_groups") {
      type GroupResult = {
        identifiers: Record<string, string>;
        label: string;
        unit: string;
        rowCount: number;
        aggregate: typeof aggregate;
        on: typeof on;
        aggregateValue: number;
        quantity: number | null;
        priceRange: { min: number; max: number } | null;
        parties: Array<{
          party: string;
          price: number;
          lineTotal: number;
          quantity: number;
        }>;
      };

      const groups: GroupResult[] = chunks.map((c) => {
        const first = c.rows[0] ?? {};
        const targetCol = firstMappingByRole(c.columnMappings, on);
        const priceCol = firstMappingByRole(c.columnMappings, "price");
        const amountCol = firstMappingByRole(c.columnMappings, "amount");
        const qtyCol = firstMappingByRole(c.columnMappings, "quantity");
        const partyCol = firstMappingByRole(c.columnMappings, "party");

        const targetValues = targetCol
          ? c.rows
              .map((r) => parseNum(r[targetCol.mappedName]))
              .filter((v) => Number.isFinite(v))
          : [];

        let aggregateValue = 0;
        if (aggregate === "count") {
          aggregateValue = targetValues.length;
        } else if (targetValues.length > 0) {
          if (aggregate === "sum")
            aggregateValue = targetValues.reduce((a, b) => a + b, 0);
          else if (aggregate === "min")
            aggregateValue = Math.min(...targetValues);
          else if (aggregate === "max")
            aggregateValue = Math.max(...targetValues);
          else if (aggregate === "mean")
            aggregateValue =
              targetValues.reduce((a, b) => a + b, 0) / targetValues.length;
        }

        const partiesArr = c.rows
          .map((r) => ({
            party: partyCol ? (r[partyCol.mappedName] ?? "") : "",
            price: priceCol ? parseNum(r[priceCol.mappedName]) : NaN,
            lineTotal: amountCol ? parseNum(r[amountCol.mappedName]) : NaN,
            quantity: qtyCol ? parseNum(r[qtyCol.mappedName]) : NaN,
          }))
          .filter((p) => p.party)
          .sort((a, b) => {
            const av = Number.isFinite(a.price) ? a.price : Infinity;
            const bv = Number.isFinite(b.price) ? b.price : Infinity;
            return av - bv;
          });

        // Hoist quantity to the group level — for bid data, every party
        // bids the same quantity for the same line item. Take the first
        // non-zero / finite value.
        let groupQuantity: number | null = null;
        if (qtyCol) {
          for (const r of c.rows) {
            const q = parseNum(r[qtyCol.mappedName]);
            if (Number.isFinite(q)) {
              groupQuantity = q;
              break;
            }
          }
        }

        const priceValues = partiesArr
          .map((p) => p.price)
          .filter((v) => Number.isFinite(v));
        const priceRange =
          priceValues.length > 0
            ? { min: Math.min(...priceValues), max: Math.max(...priceValues) }
            : null;

        return {
          identifiers: identifierValuesForRow(c.columnMappings, first),
          label: labelForRow(c.columnMappings, first),
          unit: unitForRow(c.columnMappings, first),
          rowCount: c.rows.length,
          aggregate,
          on,
          aggregateValue,
          quantity: groupQuantity,
          priceRange,
          parties: partiesArr,
        };
      });

      const sorted = groups.sort((a, b) =>
        direction === "desc"
          ? b.aggregateValue - a.aggregateValue
          : a.aggregateValue - b.aggregateValue,
      );

      return {
        operation,
        aggregate,
        on,
        direction,
        results: sorted.slice(0, n),
        caveats: Array.from(new Set(chunks.flatMap((c) => c.caveats))),
      };
    }

    if (operation === "outlier_detection") {
      const flags = chunks.flatMap((c) => {
        const first = c.rows[0] ?? {};
        const identifiers = identifierValuesForRow(c.columnMappings, first);
        const label = labelForRow(c.columnMappings, first);
        const unit = unitForRow(c.columnMappings, first);
        return c.outliers.map((o) => ({
          identifiers,
          label,
          unit,
          party: o.party,
          amount: o.amount,
          deviation: o.deviation,
          methods: o.methods,
          detail: o.detail,
        }));
      });
      return {
        operation,
        results: flags,
        caveats: Array.from(new Set(chunks.flatMap((c) => c.caveats))),
      };
    }

    if (operation === "summarize") {
      const results = chunks.map((c) => {
        const first = c.rows[0] ?? {};
        const priceCol = firstMappingByRole(c.columnMappings, "price");
        const prices = priceCol
          ? c.rows
              .map((r) => parseNum(r[priceCol.mappedName]))
              .filter((v) => Number.isFinite(v))
              .sort((a, b) => a - b)
          : [];
        const sum = prices.reduce((acc, v) => acc + v, 0);
        const mean = prices.length > 0 ? sum / prices.length : 0;
        return {
          identifiers: identifierValuesForRow(c.columnMappings, first),
          label: labelForRow(c.columnMappings, first),
          unit: unitForRow(c.columnMappings, first),
          summary: c.summary,
          rowCount: prices.length,
          priceStats: {
            min: prices[0] ?? 0,
            max: prices[prices.length - 1] ?? 0,
            mean,
            median: median(prices),
          },
          qualityScore: c.qualityScore,
          confidence: c.confidence,
          caveats: c.caveats,
          outlierCount: c.outliers.length,
        };
      });
      return { operation, results, caveats: [] };
    }

    // compare_parties
    const targets = (parties ?? []).map((p) => p.toLowerCase());
    const rows = collectRows(chunks).filter(
      (r) => targets.length === 0 || targets.includes(r.party.toLowerCase()),
    );

    const byParty = new Map<string, number[]>();
    const byPartyLineTotal = new Map<string, number[]>();
    for (const r of rows) {
      if (!byParty.has(r.party)) {
        byParty.set(r.party, []);
        byPartyLineTotal.set(r.party, []);
      }
      byParty.get(r.party)!.push(r.amount);
      if (Number.isFinite(r.lineTotal))
        byPartyLineTotal.get(r.party)!.push(r.lineTotal);
    }

    const results = Array.from(byParty.entries()).map(([party, prices]) => {
      const sorted = [...prices].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      const lineTotals = byPartyLineTotal.get(party) ?? [];
      const lineTotalSum = lineTotals.reduce((acc, v) => acc + v, 0);
      return {
        party,
        rowCount: sorted.length,
        priceStats: {
          min: sorted[0] ?? 0,
          max: sorted[sorted.length - 1] ?? 0,
          mean: sorted.length > 0 ? sum / sorted.length : 0,
          median: median(sorted),
        },
        lineTotalSum,
      };
    });

    const caveats: string[] = Array.from(
      new Set(chunks.flatMap((c) => c.caveats)),
    );
    if (targets.length > 0) {
      const found = new Set(results.map((r) => r.party.toLowerCase()));
      const missing = targets.filter((t) => !found.has(t));
      if (missing.length > 0) {
        caveats.push(`Parties with no matching rows: ${missing.join(", ")}`);
      }
    }

    return { operation, results, caveats };
  },
});

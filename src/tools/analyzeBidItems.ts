import { tool } from "ai";
import { z } from "zod";
import { getAllCsvChunks } from "../ingestion/ingestor.js";
import type { CsvChunk } from "../types.js";

function filterChunks(
  chunks: CsvChunk[],
  itemNo: string | undefined,
  projId: string | undefined,
): CsvChunk[] {
  return chunks.filter((c) => {
    const first = c.rows[0] ?? {};
    if (itemNo && first.ITEM_NO !== itemNo) return false;
    if (projId && first.PROJ_ID !== projId) return false;
    return true;
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

interface Bid {
  bidder: string;
  unitPr: number;
  extAmt: number;
  itemNo: string;
  itemDesc: string;
  unit: string;
  projId: string;
}

function collectBids(chunks: CsvChunk[]): Bid[] {
  const bids: Bid[] = [];
  for (const c of chunks) {
    for (const row of c.rows) {
      const unitPr = parseNum(row.UNIT_PR);
      if (!Number.isFinite(unitPr)) continue;
      const bidder = row.BIDDER ?? "";
      if (!bidder) continue;
      bids.push({
        bidder,
        unitPr,
        extAmt: parseNum(row.EXT_AMT),
        itemNo: row.ITEM_NO ?? "",
        itemDesc: row.ITEM_DESC ?? "",
        unit: row.UNIT ?? "",
        projId: row.PROJ_ID ?? "",
      });
    }
  }
  return bids;
}

export const analyzeBidItems = tool({
  description:
    "Numeric analysis over ingested CSV bid data. " +
    "Use this for top-N comparisons, outlier listings, per-item summaries, and bidder comparisons. " +
    "Operates on the in-memory chunk set and preserves outlier `methods` from ingestion.",
  parameters: z.object({
    operation: z
      .enum(["top_n_by_price", "outlier_detection", "summarize", "compare_bidders"])
      .describe("Which analysis to run."),
    itemNo: z
      .string()
      .optional()
      .describe("Filter to a specific bid ITEM_NO."),
    projId: z
      .string()
      .optional()
      .describe("Filter to a specific PROJ_ID."),
    n: z
      .number()
      .int()
      .positive()
      .default(5)
      .describe("How many results for top_n_by_price."),
    direction: z
      .enum(["asc", "desc"])
      .default("desc")
      .describe(
        "top_n_by_price sort order: 'desc' = most expensive first (default, matches 'top'), 'asc' = cheapest first.",
      ),
    bidders: z
      .array(z.string())
      .optional()
      .describe("Bidder names to compare (compare_bidders only)."),
  }),
  execute: async ({ operation, itemNo, projId, n, direction, bidders }) => {
    const all = getAllCsvChunks();
    const chunks = filterChunks(all, itemNo, projId);

    if (chunks.length === 0) {
      return {
        operation,
        results: [],
        caveats: ["No matching CSV chunks in memory for the given filters."],
      };
    }

    if (operation === "top_n_by_price") {
      const cmp =
        direction === "asc"
          ? (a: Bid, b: Bid) => a.unitPr - b.unitPr
          : (a: Bid, b: Bid) => b.unitPr - a.unitPr;
      const bids = collectBids(chunks).sort(cmp);
      return {
        operation,
        direction,
        results: bids.slice(0, n).map((b) => ({
          itemNo: b.itemNo,
          itemDesc: b.itemDesc,
          unit: b.unit,
          projId: b.projId,
          bidder: b.bidder,
          unitPr: b.unitPr,
          extAmt: b.extAmt,
        })),
        caveats: Array.from(new Set(chunks.flatMap((c) => c.caveats))),
      };
    }

    if (operation === "outlier_detection") {
      const flags = chunks.flatMap((c) => {
        const first = c.rows[0] ?? {};
        return c.outliers.map((o) => ({
          itemNo: first.ITEM_NO ?? "",
          itemDesc: first.ITEM_DESC ?? "",
          unit: first.UNIT ?? "",
          projId: first.PROJ_ID ?? "",
          bidder: o.bidder,
          unitPr: o.unitPr,
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
        const prices = c.rows
          .map((r) => parseNum(r.UNIT_PR))
          .filter((v) => Number.isFinite(v))
          .sort((a, b) => a - b);
        const sum = prices.reduce((acc, v) => acc + v, 0);
        const mean = prices.length > 0 ? sum / prices.length : 0;
        return {
          itemNo: first.ITEM_NO ?? "",
          itemDesc: first.ITEM_DESC ?? "",
          unit: first.UNIT ?? "",
          projId: first.PROJ_ID ?? "",
          summary: c.summary,
          bidCount: prices.length,
          minUnitPr: prices[0] ?? 0,
          maxUnitPr: prices[prices.length - 1] ?? 0,
          meanUnitPr: mean,
          medianUnitPr: median(prices),
          qualityScore: c.qualityScore,
          confidence: c.confidence,
          caveats: c.caveats,
          outlierCount: c.outliers.length,
        };
      });
      return { operation, results, caveats: [] };
    }

    // compare_bidders
    const targets = (bidders ?? []).map((b) => b.toLowerCase());
    const bids = collectBids(chunks).filter(
      (b) => targets.length === 0 || targets.includes(b.bidder.toLowerCase()),
    );

    const byBidder = new Map<string, number[]>();
    const byBidderExt = new Map<string, number[]>();
    for (const b of bids) {
      if (!byBidder.has(b.bidder)) {
        byBidder.set(b.bidder, []);
        byBidderExt.set(b.bidder, []);
      }
      byBidder.get(b.bidder)!.push(b.unitPr);
      if (Number.isFinite(b.extAmt)) byBidderExt.get(b.bidder)!.push(b.extAmt);
    }

    const results = Array.from(byBidder.entries()).map(([bidder, prices]) => {
      const sorted = [...prices].sort((a, b) => a - b);
      const sum = sorted.reduce((acc, v) => acc + v, 0);
      const ext = byBidderExt.get(bidder) ?? [];
      const extTotal = ext.reduce((acc, v) => acc + v, 0);
      return {
        bidder,
        bidCount: sorted.length,
        minUnitPr: sorted[0] ?? 0,
        maxUnitPr: sorted[sorted.length - 1] ?? 0,
        meanUnitPr: sorted.length > 0 ? sum / sorted.length : 0,
        medianUnitPr: median(sorted),
        totalExtAmt: extTotal,
      };
    });

    const caveats: string[] = Array.from(
      new Set(chunks.flatMap((c) => c.caveats)),
    );
    if (targets.length > 0) {
      const found = new Set(results.map((r) => r.bidder.toLowerCase()));
      const missing = targets.filter((t) => !found.has(t));
      if (missing.length > 0) {
        caveats.push(`Bidders with no matching bids: ${missing.join(", ")}`);
      }
    }

    return { operation, results, caveats };
  },
});

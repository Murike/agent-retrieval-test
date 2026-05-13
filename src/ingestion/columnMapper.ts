import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type { ColumnMapping, ColumnMappingResult } from "../types.js";

const SYNONYM_MAP: Record<string, string[]> = {
  PROJ_ID: ["project_id", "proj_id", "project id", "project_number", "proj_no"],
  LET_DT: ["let_dt", "let date", "letting_date", "bid_date", "date"],
  CNTY: ["cnty", "county", "county_name", "location", "region"],
  ITEM_NO: ["item_no", "item_number", "line_no", "line_number", "item #"],
  ITEM_DESC: ["item_desc", "item_description", "description", "desc", "name"],
  UNIT: ["unit", "unit_of_measure", "uom", "measure"],
  QTY: ["qty", "quantity", "amount", "count"],
  ENG_EST_UNIT_PR: [
    "eng_est_unit_pr",
    "engineer_estimate",
    "estimated_unit_price",
    "eng_unit_pr",
  ],
  UNIT_PR: ["unit_pr", "unit_price", "price", "unit_cost", "rate"],
  EXT_AMT: [
    "ext_amt",
    "extended_amount",
    "total_amount",
    "line_total",
    "total_cost",
  ],
  BIDDER: ["bidder", "contractor", "vendor", "company", "company_name"],
  BID_RANK: ["bid_rank", "rank", "ranking", "position"],
  BID_TOTAL: ["bid_total", "total_bid", "bid_amount", "grand_total", "total"],
};

const CANONICAL_TARGETS = Object.keys(SYNONYM_MAP);

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_]+/g, "_");
}

const NORMALIZED_SYNONYMS: Record<string, string> = {};
for (const [canonical, variants] of Object.entries(SYNONYM_MAP)) {
  NORMALIZED_SYNONYMS[normalize(canonical)] = canonical;
  for (const v of variants) {
    NORMALIZED_SYNONYMS[normalize(v)] = canonical;
  }
}

const LlmResponseSchema = z.object({
  mappings: z.array(
    z.object({
      originalHeader: z.string(),
      mappedName: z.string(),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

export async function mapColumns(
  headers: string[],
): Promise<ColumnMappingResult> {
  const mappings: ColumnMapping[] = [];
  const unresolved: string[] = [];

  for (const header of headers) {
    const canonical = NORMALIZED_SYNONYMS[normalize(header)];
    if (canonical) {
      mappings.push({
        originalHeader: header,
        mappedName: canonical,
        tier: "synonym",
        confidence: 1.0,
      });
    } else {
      unresolved.push(header);
    }
  }

  if (unresolved.length === 0) {
    return { mappings, unmapped: [] };
  }

  let llmMappings: Array<{
    originalHeader: string;
    mappedName: string;
    confidence: number;
  }> = [];

  try {
    const result = await generateObject({
      model: openai("gpt-4o-mini"),
      schema: LlmResponseSchema,
      system:
        "You map raw CSV headers to canonical bid-data field names. " +
        "Respond with JSON only. " +
        "For each header, choose the best canonical target from the provided list, " +
        "or return the original header unchanged with a low confidence if you are unsure.",
      prompt:
        `Unresolved headers:\n${JSON.stringify(unresolved)}\n\n` +
        `Canonical targets:\n${JSON.stringify(CANONICAL_TARGETS)}\n\n` +
        `Return one mapping per header with originalHeader, mappedName, and confidence (0..1).`,
    });
    llmMappings = result.object.mappings;
  } catch {
    llmMappings = [];
  }

  const llmByHeader = new Map(llmMappings.map((m) => [m.originalHeader, m]));
  const unmapped: string[] = [];

  for (const header of unresolved) {
    const m = llmByHeader.get(header);
    if (m && CANONICAL_TARGETS.includes(m.mappedName) && m.confidence > 0) {
      mappings.push({
        originalHeader: header,
        mappedName: m.mappedName,
        tier: "llm",
        confidence: m.confidence,
      });
    } else {
      mappings.push({
        originalHeader: header,
        mappedName: header,
        tier: "unmapped",
        confidence: 0,
      });
      unmapped.push(header);
    }
  }

  return { mappings, unmapped };
}

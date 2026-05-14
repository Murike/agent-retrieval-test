import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import type {
  ColumnMapping,
  ColumnMappingResult,
  FieldRole,
} from "../types.js";

interface CanonicalField {
  name: string;
  role: FieldRole;
  semanticLabel: string;
  synonyms: string[];
}

const CANONICAL_FIELDS: CanonicalField[] = [
  {
    name: "PROJ_ID",
    role: "identifier",
    semanticLabel: "Project identifier",
    synonyms: [
      "project_id",
      "proj_id",
      "project id",
      "project_number",
      "proj_no",
    ],
  },
  {
    name: "LET_DT",
    role: "date",
    semanticLabel: "Letting / bid date",
    synonyms: ["let_dt", "let date", "letting_date", "bid_date", "date"],
  },
  {
    name: "CNTY",
    role: "location",
    semanticLabel: "County or geographic location",
    synonyms: ["cnty", "county", "county_name", "location", "region"],
  },
  {
    name: "ITEM_NO",
    role: "identifier",
    semanticLabel: "Line item number",
    synonyms: [
      "item_no",
      "item_number",
      "line_no",
      "line_number",
      "item #",
      "id",
      "identifier",
      "key",
    ],
  },
  {
    name: "ITEM_DESC",
    role: "label",
    semanticLabel: "Line item description",
    synonyms: ["item_desc", "item_description", "description", "desc", "name"],
  },
  {
    name: "UNIT",
    role: "unit",
    semanticLabel: "Unit of measure",
    synonyms: ["unit", "unit_of_measure", "uom", "measure"],
  },
  {
    name: "QTY",
    role: "quantity",
    semanticLabel: "Quantity",
    synonyms: ["qty", "quantity", "amount", "count"],
  },
  {
    name: "ENG_EST_UNIT_PR",
    role: "price",
    semanticLabel: "Engineer estimate of unit price",
    synonyms: [
      "eng_est_unit_pr",
      "engineer_estimate",
      "estimated_unit_price",
      "eng_unit_pr",
    ],
  },
  {
    name: "UNIT_PR",
    role: "price",
    semanticLabel: "Unit price",
    synonyms: ["unit_pr", "unit_price", "price", "unit_cost", "rate", "value"],
  },
  {
    name: "EXT_AMT",
    role: "amount",
    semanticLabel: "Extended (line-total) amount",
    synonyms: [
      "ext_amt",
      "extended_amount",
      "total_amount",
      "line_total",
      "total_cost",
      "amount",
    ],
  },
  {
    name: "BIDDER",
    role: "party",
    semanticLabel: "Bidder / contractor / vendor",
    synonyms: [
      "bidder",
      "contractor",
      "vendor",
      "company",
      "company_name",
      "party",
      "supplier",
      "customer",
    ],
  },
  {
    name: "BID_RANK",
    role: "rank",
    semanticLabel: "Bid rank",
    synonyms: ["bid_rank", "rank", "ranking", "position"],
  },
  {
    name: "BID_TOTAL",
    role: "amount",
    semanticLabel: "Total bid amount",
    synonyms: ["bid_total", "total_bid", "bid_amount", "grand_total", "total"],
  },
];

const CANONICAL_BY_NAME: Record<string, CanonicalField> = {};
for (const field of CANONICAL_FIELDS) {
  CANONICAL_BY_NAME[field.name] = field;
}

const CANONICAL_TARGETS = CANONICAL_FIELDS.map((f) => f.name);

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/[\s_]+/g, "_");
}

const NORMALIZED_SYNONYMS: Record<string, string> = {};
for (const field of CANONICAL_FIELDS) {
  NORMALIZED_SYNONYMS[normalize(field.name)] = field.name;
  for (const v of field.synonyms) {
    NORMALIZED_SYNONYMS[normalize(v)] = field.name;
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
      const field = CANONICAL_BY_NAME[canonical];
      mappings.push({
        originalHeader: header,
        mappedName: canonical,
        tier: "synonym",
        confidence: 1.0,
        role: field.role,
        semanticLabel: field.semanticLabel,
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
        "You map raw CSV headers to canonical semantic field names. " +
        "Respond with JSON only. " +
        "For each header, choose the best canonical target from the provided list, " +
        "or return the original header unchanged with a low confidence if you are unsure.",
      prompt:
        `Unresolved headers:\n${JSON.stringify(unresolved)}\n\n` +
        `Canonical targets (with role and semantic label for context):\n` +
        `${JSON.stringify(
          CANONICAL_FIELDS.map((f) => ({
            name: f.name,
            role: f.role,
            semanticLabel: f.semanticLabel,
          })),
        )}\n\n` +
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
      const field = CANONICAL_BY_NAME[m.mappedName];
      mappings.push({
        originalHeader: header,
        mappedName: m.mappedName,
        tier: "llm",
        confidence: m.confidence,
        role: field.role,
        semanticLabel: field.semanticLabel,
      });
    } else {
      mappings.push({
        originalHeader: header,
        mappedName: header,
        tier: "unmapped",
        confidence: 0,
        role: "extra",
        semanticLabel: "",
      });
      unmapped.push(header);
    }
  }

  return { mappings, unmapped };
}

export { CANONICAL_FIELDS };
export type { CanonicalField };

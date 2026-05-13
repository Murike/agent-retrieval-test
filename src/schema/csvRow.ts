import { z } from "zod";
import type { ColumnMapping } from "../types.js";

const NUMERIC_FIELDS = new Set([
  "QTY",
  "ENG_EST_UNIT_PR",
  "UNIT_PR",
  "EXT_AMT",
  "BID_RANK",
  "BID_TOTAL",
]);

export function buildRowSchema(mappings: ColumnMapping[]) {
  const shape: z.ZodRawShape = {};

  for (const mapping of mappings) {
    if (mapping.tier === "unmapped") continue;

    shape[mapping.mappedName] = NUMERIC_FIELDS.has(mapping.mappedName)
      ? z.coerce.number()
      : z.string();
  }

  return z.object(shape).passthrough();
}

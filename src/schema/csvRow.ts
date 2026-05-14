import { z } from "zod";
import type { ColumnMapping, FieldRole } from "../types.js";

const NUMERIC_ROLES: ReadonlySet<FieldRole> = new Set<FieldRole>([
  "price",
  "amount",
  "quantity",
  "rank",
]);

export function isNumericRole(role: FieldRole): boolean {
  return NUMERIC_ROLES.has(role);
}

export function buildRowSchema(mappings: ColumnMapping[]) {
  const shape: z.ZodRawShape = {};

  for (const mapping of mappings) {
    if (mapping.tier === "unmapped") continue;

    shape[mapping.mappedName] = isNumericRole(mapping.role)
      ? z.coerce.number()
      : z.string();
  }

  return z.object(shape).passthrough();
}

import { tool } from "ai";
import { z } from "zod";

export const compare = tool({
  description:
    "Deterministically compare numeric values across a set of records the user has already seen. " +
    "Use this whenever the user asks a comparative or aggregate question (highest, lowest, largest, smallest, " +
    "max, min, sort, ranking, 'which has the most/least', 'is A greater than B') over records that appeared " +
    "in a prior assistant message. Read each record's value from the prior turn, pass them as plain integers " +
    "or floats (no thousands separators, no units), and report what this tool returns. Never compare numbers " +
    "in prose without calling this tool when records came from a prior turn.",
  parameters: z.object({
    records: z
      .array(
        z.object({
          label: z
            .string()
            .describe("Human-readable name of the record, taken from the prior turn."),
          value: z
            .number()
            .describe("Numeric value to compare. Pass digits only — strip commas and units."),
        }),
      )
      .min(1)
      .describe("The records to compare. Must contain at least one entry."),
    operation: z
      .enum(["max", "min", "sort_desc", "sort_asc"])
      .describe(
        "max: return the record with the largest value. " +
          "min: return the record with the smallest value. " +
          "sort_desc / sort_asc: return all records sorted by value.",
      ),
    unit: z
      .string()
      .optional()
      .describe("Optional unit label to echo back in the result (e.g., 'LF', 'EA', 'USD')."),
  }),
  execute: async ({ records, operation, unit }) => {
    const sortedDesc = [...records].sort((a, b) => b.value - a.value);

    if (operation === "max") {
      const winner = sortedDesc[0];
      return { operation, unit, winner, ranked: sortedDesc };
    }
    if (operation === "min") {
      const winner = sortedDesc[sortedDesc.length - 1];
      return { operation, unit, winner, ranked: [...sortedDesc].reverse() };
    }
    if (operation === "sort_desc") {
      return { operation, unit, ranked: sortedDesc };
    }
    return { operation, unit, ranked: [...sortedDesc].reverse() };
  },
});

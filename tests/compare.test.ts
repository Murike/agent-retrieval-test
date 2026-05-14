import { describe, it, expect } from "vitest";
import { compare } from "../src/tools/compare.js";

type CompareResult = {
  operation: "max" | "min" | "sort_desc" | "sort_asc";
  unit?: string;
  winner?: { label: string; value: number };
  ranked: { label: string; value: number }[];
};

async function run(
  records: { label: string; value: number }[],
  operation: "max" | "min" | "sort_desc" | "sort_asc",
  unit?: string,
): Promise<CompareResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (await (compare as any).execute({ records, operation, unit })) as CompareResult;
}

describe("compare tool", () => {
  const recs = [
    { label: "4\" YELLOW SOLID LINES", value: 2432998 },
    { label: "REMOVAL OF PAVEMENT MARKINGS", value: 3019789 },
    { label: "PERMANENT YELLOW PAVEMENT MARKERS", value: 63000 },
  ];

  it("max returns the largest record", async () => {
    const out = await run(recs, "max", "LF");
    expect(out.winner).toEqual({
      label: "REMOVAL OF PAVEMENT MARKINGS",
      value: 3019789,
    });
    expect(out.ranked.map((r) => r.value)).toEqual([3019789, 2432998, 63000]);
    expect(out.unit).toBe("LF");
  });

  it("min returns the smallest record", async () => {
    const out = await run(recs, "min");
    expect(out.winner).toEqual({
      label: "PERMANENT YELLOW PAVEMENT MARKERS",
      value: 63000,
    });
    expect(out.ranked.map((r) => r.value)).toEqual([63000, 2432998, 3019789]);
  });

  it("sort_desc returns all records descending", async () => {
    const out = await run(recs, "sort_desc");
    expect(out.winner).toBeUndefined();
    expect(out.ranked.map((r) => r.value)).toEqual([3019789, 2432998, 63000]);
  });

  it("sort_asc returns all records ascending", async () => {
    const out = await run(recs, "sort_asc");
    expect(out.winner).toBeUndefined();
    expect(out.ranked.map((r) => r.value)).toEqual([63000, 2432998, 3019789]);
  });

  it("handles a single-record input", async () => {
    const out = await run([{ label: "only", value: 42 }], "max");
    expect(out.winner).toEqual({ label: "only", value: 42 });
    expect(out.ranked).toEqual([{ label: "only", value: 42 }]);
  });
});

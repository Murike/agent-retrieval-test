import { describe, it, expect } from "vitest";
import {
  groupByIdentifier,
  groupByRowWindow,
} from "../../src/chunking/csv.js";

interface Row {
  id: string;
  value: number;
}

describe("groupByIdentifier", () => {
  it("buckets rows by identifier-value tuple", () => {
    const rows: Row[] = [
      { id: "A", value: 1 },
      { id: "B", value: 2 },
      { id: "A", value: 3 },
    ];
    const groups = groupByIdentifier(rows, (r) => [r.id]);

    expect(groups.size).toBe(2);
    expect(groups.get("A")!.rows).toEqual([
      { id: "A", value: 1 },
      { id: "A", value: 3 },
    ]);
    expect(groups.get("A")!.identifierValues).toEqual(["A"]);
    expect(groups.get("B")!.rows).toEqual([{ id: "B", value: 2 }]);
  });

  it("uses composite identifier tuples as keys", () => {
    const rows: Row[] = [
      { id: "A", value: 1 },
      { id: "A", value: 1 },
      { id: "A", value: 2 },
    ];
    const groups = groupByIdentifier(rows, (r) => [r.id, String(r.value)]);

    expect(groups.size).toBe(2);
    expect(groups.has("A::1")).toBe(true);
    expect(groups.has("A::2")).toBe(true);
    expect(groups.get("A::1")!.rows).toHaveLength(2);
  });

  it("returns an empty map for an empty row list", () => {
    const groups = groupByIdentifier<Row>([], (r) => [r.id]);
    expect(groups.size).toBe(0);
  });
});

describe("groupByRowWindow", () => {
  it("splits rows into windows of the requested size", () => {
    const rows: Row[] = Array.from({ length: 250 }, (_, i) => ({
      id: String(i),
      value: i,
    }));
    const groups = groupByRowWindow(rows, 100);

    expect(groups.size).toBe(3);
    expect(groups.get("part0")!.rows).toHaveLength(100);
    expect(groups.get("part1")!.rows).toHaveLength(100);
    expect(groups.get("part2")!.rows).toHaveLength(50);
  });

  it("preserves order within and across windows", () => {
    const rows: Row[] = Array.from({ length: 7 }, (_, i) => ({
      id: String(i),
      value: i,
    }));
    const groups = groupByRowWindow(rows, 3);

    expect(groups.get("part0")!.rows.map((r) => r.value)).toEqual([0, 1, 2]);
    expect(groups.get("part1")!.rows.map((r) => r.value)).toEqual([3, 4, 5]);
    expect(groups.get("part2")!.rows.map((r) => r.value)).toEqual([6]);
  });

  it("uses the synthetic part key as the identifierValues marker", () => {
    const rows: Row[] = [{ id: "x", value: 1 }];
    const groups = groupByRowWindow(rows, 10);
    expect(groups.get("part0")!.identifierValues).toEqual(["part0"]);
  });

  it("returns an empty map for an empty row list", () => {
    const groups = groupByRowWindow<Row>([], 100);
    expect(groups.size).toBe(0);
  });

  it("defaults the window size to the configured value when omitted", () => {
    const rows: Row[] = Array.from({ length: 150 }, (_, i) => ({
      id: String(i),
      value: i,
    }));
    const groups = groupByRowWindow(rows);

    expect(groups.size).toBe(2);
    expect(groups.get("part0")!.rows).toHaveLength(100);
    expect(groups.get("part1")!.rows).toHaveLength(50);
  });
});

import type { OutlierFlag } from "../types.js";

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

export function detectOutliers(
  bids: Array<{ bidder: string; unitPr: number }>,
): OutlierFlag[] {
  if (bids.length < 3) return [];

  const values = bids.map((b) => b.unitPr);
  const sorted = [...values].sort((a, b) => a - b);

  const med = quantile(sorted, 0.5);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const iqrLow = q1 - 1.5 * iqr;
  const iqrHigh = q3 + 1.5 * iqr;

  const mad = median(values.map((v) => Math.abs(v - med)));
  const min = sorted[0];

  const flags: OutlierFlag[] = [];

  for (const bid of bids) {
    const methods: Array<"iqr" | "mad" | "ratio_to_min"> = [];

    if (iqr > 0 && (bid.unitPr < iqrLow || bid.unitPr > iqrHigh)) {
      methods.push("iqr");
    }
    if (mad > 0 && Math.abs(bid.unitPr - med) > 3 * mad) {
      methods.push("mad");
    }
    if (min > 0 && bid.unitPr > 2 * min) {
      methods.push("ratio_to_min");
    }

    if (methods.length === 0) continue;

    const deviation: "high" | "low" = bid.unitPr > med ? "high" : "low";
    flags.push({
      bidder: bid.bidder,
      unitPr: bid.unitPr,
      deviation,
      methods,
      detail:
        `unitPr ${bid.unitPr} vs median ${med.toFixed(2)} ` +
        `(flagged by: ${methods.join(", ")})`,
    });
  }

  return flags;
}

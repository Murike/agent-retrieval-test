import {
  PDF_MAX_CHARS_PER_CHUNK,
  PDF_OVERLAP_CHARS,
} from "./config.js";

export interface PageSegment {
  pageNum: number;
  segment: number;
  text: string;
}

// Split a single page's text into overlapping windows when it exceeds the
// per-chunk character budget. A page that fits in one window emits one
// segment (segment: 0); a longer page emits N segments with `overlapChars`
// of duplicated tail/head between consecutive windows so that sentences
// straddling a boundary remain retrievable from at least one chunk.
export function splitPageText(
  text: string,
  pageNum: number,
  maxCharsPerChunk: number = PDF_MAX_CHARS_PER_CHUNK,
  overlapChars: number = PDF_OVERLAP_CHARS,
): PageSegment[] {
  if (text.length <= maxCharsPerChunk) {
    return [{ pageNum, segment: 0, text }];
  }
  if (overlapChars >= maxCharsPerChunk) {
    throw new Error(
      `overlapChars (${overlapChars}) must be less than maxCharsPerChunk (${maxCharsPerChunk})`,
    );
  }

  const segments: PageSegment[] = [];
  const step = maxCharsPerChunk - overlapChars;
  let start = 0;
  let segment = 0;
  while (start < text.length) {
    const slice = text.slice(start, start + maxCharsPerChunk);
    segments.push({ pageNum, segment, text: slice });
    if (start + maxCharsPerChunk >= text.length) break;
    start += step;
    segment++;
  }
  return segments;
}

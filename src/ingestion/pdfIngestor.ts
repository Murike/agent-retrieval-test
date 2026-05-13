import { readFile } from "node:fs/promises";
import path from "node:path";
// Legacy build is the Node-compatible entrypoint for pdfjs-dist.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker } from "tesseract.js";
import type { PdfChunk } from "../types.js";

const MIN_TEXT_LENGTH = 50;
const LOW_OCR_CONFIDENCE = 0.7;

// Render a pdfjs page to a PNG buffer. `canvas` is dynamically imported so
// systems that don't have pixman/cairo installed can still ingest CSV (and
// PDFs with usable text layers) — only the OCR fallback degrades.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function renderPageToPng(page: any): Promise<Buffer | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const canvasMod: any = await import("canvas");
    const viewport = page.getViewport({ scale: 2.0 });
    const canvas = canvasMod.createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toBuffer("image/png");
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function joinPageText(textContent: any): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = (textContent.items ?? []) as any[];
  return items
    .map((it) => (typeof it.str === "string" ? it.str : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function ingestPdf(filePath: string): Promise<PdfChunk[]> {
  const buf = await readFile(filePath);
  const data = new Uint8Array(buf);

  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  const doc = await loadingTask.promise;
  const fileBase = path.basename(filePath);

  const chunks: PdfChunk[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let worker: any = null;

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const textContent = await page.getTextContent();
    const text = joinPageText(textContent);

    if (text.length >= MIN_TEXT_LENGTH) {
      chunks.push({
        id: `pdf::${fileBase}::p${i}`,
        pageNum: i,
        text,
        method: "text_layer",
        qualityScore: 1.0,
        groundedness: "direct",
        confidence: 1.0,
        warnings: [],
      });
      continue;
    }

    // Text layer was empty or too short — try OCR.
    const warnings: string[] = [];
    const image = await renderPageToPng(page);
    if (!image) {
      // Canvas isn't available (native deps missing) — keep the short text
      // layer text with low confidence and a warning. Never drop the page.
      warnings.push(
        "OCR fallback unavailable; install the `canvas` package's native dependencies for image rendering",
      );
      chunks.push({
        id: `pdf::${fileBase}::p${i}`,
        pageNum: i,
        text,
        method: "text_layer",
        qualityScore: 0.2,
        groundedness: "direct",
        confidence: 0.2,
        warnings,
      });
      continue;
    }

    if (!worker) {
      worker = await createWorker("eng");
    }
    const result = await worker.recognize(image);
    const ocrText = (result.data.text ?? "").trim();
    const ocrConfidence = (result.data.confidence ?? 0) / 100;
    if (ocrConfidence < LOW_OCR_CONFIDENCE) {
      warnings.push("Low OCR confidence — content may be inaccurate");
    }

    chunks.push({
      id: `pdf::${fileBase}::p${i}`,
      pageNum: i,
      text: ocrText,
      method: "ocr",
      qualityScore: ocrConfidence,
      groundedness: "direct",
      confidence: ocrConfidence,
      warnings,
    });
  }

  if (worker) {
    await worker.terminate();
  }

  return chunks;
}

import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
// Legacy build is the Node-compatible entrypoint for pdfjs-dist.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createWorker } from "tesseract.js";
import type { PdfChunk } from "../types.js";

const MIN_TEXT_LENGTH = 50;
const LOW_OCR_CONFIDENCE = 0.7;
const OCRMYPDF_CONFIDENCE = 0.85;
const OCR_FAILED_CONFIDENCE = 0.2;

interface OcrTarget {
  pageNum: number;
  fallbackText: string;
}

// Probe ocrmypdf availability once per process. The primary OCR path uses the
// CLI binary; if it isn't installed we transparently fall through to the
// pdf-to-img + tesseract.js fallback.
let ocrmypdfProbe: Promise<boolean> | null = null;
async function hasOcrmypdf(): Promise<boolean> {
  if (!ocrmypdfProbe) {
    ocrmypdfProbe = (async () => {
      try {
        await execa("ocrmypdf", ["--version"]);
        return true;
      } catch {
        console.warn(
          "[pdf] ocrmypdf not found on PATH; OCR will use the pdf-to-img + tesseract.js fallback (slower). Install ocrmypdf to speed this up.",
        );
        return false;
      }
    })();
  }
  return ocrmypdfProbe;
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

async function loadDoc(data: Uint8Array): Promise<pdfjs.PDFDocumentProxy> {
  const loadingTask = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  return loadingTask.promise;
}

async function extractPageText(
  doc: pdfjs.PDFDocumentProxy,
  pageNum: number,
): Promise<string> {
  const page = await doc.getPage(pageNum);
  const textContent = await page.getTextContent();
  return joinPageText(textContent);
}

// Primary OCR: rewrite the whole file once with ocrmypdf --skip-text, then
// pull text for the pages that needed OCR via pdfjs. ocrmypdf only OCRs pages
// without an existing text layer, so we don't redo work for hybrid PDFs.
async function ocrViaOcrmypdf(
  filePath: string,
  fileBase: string,
  targets: OcrTarget[],
): Promise<PdfChunk[]> {
  const workDir = mkdtempSync(path.join(tmpdir(), "ocrmypdf-"));
  const outPath = path.join(workDir, "out.pdf");
  try {
    await execa("ocrmypdf", [
      "--skip-text",
      "--output-type",
      "pdf",
      "--quiet",
      filePath,
      outPath,
    ], { stdio: 'inherit' });

    const buf = await readFile(outPath);
    const doc = await loadDoc(new Uint8Array(buf));

    const chunks: PdfChunk[] = [];
    for (const { pageNum, fallbackText } of targets) {
      const text = await extractPageText(doc, pageNum);
      const finalText = text.length > 0 ? text : fallbackText;
      const warnings = ["OCR via ocrmypdf"];
      if (finalText.length < MIN_TEXT_LENGTH) {
        warnings.push(
          "Page yielded little text after OCR — may be image-only or unsupported layout",
        );
      }
      chunks.push({
        id: `pdf::${fileBase}::p${pageNum}`,
        pageNum,
        text: finalText,
        method: "ocr",
        qualityScore: OCRMYPDF_CONFIDENCE,
        groundedness: "direct",
        confidence: OCRMYPDF_CONFIDENCE,
        warnings,
      });
    }
    return chunks;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// Fallback OCR: per-page rasterize with pdf-to-img (pure-Node, no system libs)
// and OCR each PNG with tesseract.js. Slower than ocrmypdf but works wherever
// Node runs. Dynamically imported so a missing pdf-to-img install doesn't
// crash module load.
async function ocrViaFallback(
  filePath: string,
  fileBase: string,
  targets: OcrTarget[],
): Promise<PdfChunk[]> {
  const needed = new Map(targets.map((t) => [t.pageNum, t.fallbackText]));
  const chunks: PdfChunk[] = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfToImg: any;
  try {
    pdfToImg = await import("pdf-to-img");
  } catch (err) {
    return targets.map((t) => emitFailedChunk(fileBase, t, err));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let worker: any = null;
  try {
    const pages = await pdfToImg.pdf(filePath, { scale: 2 });
    let pageNum = 0;
    for await (const png of pages) {
      pageNum++;
      const fallbackText = needed.get(pageNum);
      if (fallbackText === undefined) continue;

      if (!worker) {
        worker = await createWorker("eng");
      }
      const result = await worker.recognize(png);
      const ocrText = (result.data.text ?? "").trim();
      const ocrConfidence = (result.data.confidence ?? 0) / 100;
      const warnings = ["OCR via pdf-to-img + tesseract.js"];
      if (ocrConfidence < LOW_OCR_CONFIDENCE) {
        warnings.push("Low OCR confidence — content may be inaccurate");
      }
      chunks.push({
        id: `pdf::${fileBase}::p${pageNum}`,
        pageNum,
        text: ocrText || fallbackText,
        method: "ocr",
        qualityScore: ocrConfidence,
        groundedness: "direct",
        confidence: ocrConfidence,
        warnings,
      });
      needed.delete(pageNum);
    }
  } catch (err) {
    for (const [pageNum, fallbackText] of needed) {
      chunks.push(
        emitFailedChunk(fileBase, { pageNum, fallbackText }, err),
      );
      needed.delete(pageNum);
    }
  } finally {
    if (worker) await worker.terminate();
  }

  // Any pages pdf-to-img skipped (e.g., out-of-range, render failure) get a
  // low-confidence chunk so they aren't silently dropped from the index.
  for (const [pageNum, fallbackText] of needed) {
    chunks.push(
      emitFailedChunk(fileBase, { pageNum, fallbackText }, new Error("page not rendered")),
    );
  }
  return chunks;
}

function emitFailedChunk(
  fileBase: string,
  target: OcrTarget,
  err: unknown,
): PdfChunk {
  const detail = err instanceof Error ? err.message : String(err);
  return {
    id: `pdf::${fileBase}::p${target.pageNum}`,
    pageNum: target.pageNum,
    text: target.fallbackText,
    method: "text_layer",
    qualityScore: OCR_FAILED_CONFIDENCE,
    groundedness: "direct",
    confidence: OCR_FAILED_CONFIDENCE,
    warnings: [`OCR fallback failed: ${detail}`],
  };
}

export async function ingestPdf(filePath: string): Promise<PdfChunk[]> {
  const buf = await readFile(filePath);
  const doc = await loadDoc(new Uint8Array(buf));
  const fileBase = path.basename(filePath);

  const chunks: PdfChunk[] = [];
  const ocrTargets: OcrTarget[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const text = await extractPageText(doc, i);
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
    } else {
      ocrTargets.push({ pageNum: i, fallbackText: text });
    }
  }

  if (ocrTargets.length > 0) {
    let ocrChunks: PdfChunk[] | null = null;
    if (await hasOcrmypdf()) {
      try {
        ocrChunks = await ocrViaOcrmypdf(filePath, fileBase, ocrTargets);
      } catch (err) {
        console.warn(
          `[pdf] ocrmypdf failed (${err instanceof Error ? err.message : String(err)}); falling back to pdf-to-img + tesseract.js`,
        );
      }
    }
    if (!ocrChunks) {
      ocrChunks = await ocrViaFallback(filePath, fileBase, ocrTargets);
    }
    chunks.push(...ocrChunks);
  }

  chunks.sort((a, b) => a.pageNum - b.pageNum);
  return chunks;
}

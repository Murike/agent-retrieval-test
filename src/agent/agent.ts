import { generateText, type CoreMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { searchDocuments } from "../tools/searchDocuments.js";
import { analyzeNumericFields } from "../tools/analyzeNumericFields.js";
import { queryPdf } from "../tools/queryPdf.js";
import { ingestFile } from "../tools/ingestFile.js";
import { compare } from "../tools/compare.js";
import { listIngested, getAllCsvChunks } from "../ingestion/ingestor.js";
import type { AgentAnswer, ColumnMapping } from "../types.js";

function buildSchemaPreface(): string {
  const chunks = getAllCsvChunks();
  if (chunks.length === 0) return "";

  // Aggregate columnMappings across chunks. Use mappedName as the key so the
  // same canonical field reported by multiple chunks collapses to one entry.
  const byName = new Map<string, ColumnMapping>();
  for (const c of chunks) {
    for (const m of c.columnMappings) {
      if (m.tier === "unmapped") continue;
      if (!byName.has(m.mappedName)) byName.set(m.mappedName, m);
    }
  }
  if (byName.size === 0) return "";

  const lines = Array.from(byName.values()).map(
    (m) => `- ${m.mappedName} (${m.role}): ${m.semanticLabel}`,
  );
  return `Currently ingested CSV columns (semantic roles):\n${lines.join("\n")}`;
}

function buildSystemAppendix(): string {
  const files = listIngested();
  if (files.length === 0) {
    return "No files have been ingested yet.";
  }
  const lines = files
    .map((f) => `- ${f.path} (${f.type}, ${f.chunkCount} chunks)`)
    .join("\n");
  const schemaPreface = buildSchemaPreface();
  const schemaBlock = schemaPreface ? `\n\n${schemaPreface}` : "";
  return `Currently ingested files (already loaded — do not ask the user to provide them again, just query them with the available tools):
${lines}${schemaBlock}`;
}

const AgentAnswerSchema = z.object({
  answer: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  grounded_in_context: z.boolean(),
  data_caveats: z.array(z.string()),
  sources: z.array(
    z.object({
      type: z.enum(["csv_row", "pdf_chunk"]),
      reference: z.string(),
    }),
  ),
});

function extractJson(text: string): string | null {
  // Strip ```json fences if the model added them despite the prompt.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

export async function runAgent(
  userQuery: string,
  history: CoreMessage[] = [],
): Promise<{ answer: AgentAnswer; history: CoreMessage[] }> {
  const userMessage: CoreMessage = {
    role: "user",
    content: userQuery,
  };
  const appendix = buildSystemAppendix();
  const systemPrompt = appendix ? `${SYSTEM_PROMPT}\n\n${appendix}` : SYSTEM_PROMPT;
  const result = await generateText({
    model: openai("gpt-4o"),
    maxSteps: 10,
    system: systemPrompt,
    tools: {
      ingestFile,
      searchDocuments,
      analyzeNumericFields,
      queryPdf,
      compare,
    },
    messages: [...history, userMessage],
  });
  const nextHistory: CoreMessage[] = [
    ...history,
    userMessage,
    ...(result.response?.messages ?? []),
  ];

  const raw = extractJson(result.text);
  if (!raw) {
    return {
      answer: {
        answer: result.text || "No answer produced.",
        confidence: "low",
        grounded_in_context: false,
        data_caveats: ["Agent did not return JSON; raw model text was preserved."],
        sources: [],
      },
      history: nextHistory,
    };
  }

  try {
    const parsed = JSON.parse(raw);
    const validated = AgentAnswerSchema.parse(parsed);
    return { answer: validated, history: nextHistory };
  } catch (err) {
    return {
      answer: {
        answer: result.text,
        confidence: "low",
        grounded_in_context: false,
        data_caveats: [
          `Agent output failed schema validation: ${err instanceof Error ? err.message : String(err)}`,
        ],
        sources: [],
      },
      history: nextHistory,
    };
  }
}

import { generateText, type CoreMessage } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";
import { SYSTEM_PROMPT } from "./systemPrompt.js";
import { searchDocuments } from "../tools/searchDocuments.js";
import { analyzeBidItems } from "../tools/analyzeBidItems.js";
import { queryPlanSet } from "../tools/queryPlanSet.js";
import { ingestFile } from "../tools/ingestFile.js";
import { listIngested } from "../ingestion/ingestor.js";
import type { AgentAnswer } from "../types.js";

function buildPrompt(userQuery: string): string {
  const files = listIngested();
  if (files.length === 0) {
    return `No files have been ingested yet.\n\nUser question: ${userQuery}`;
  }
  const lines = files
    .map((f) => `- ${f.path} (${f.type}, ${f.chunkCount} chunks)`)
    .join("\n");
  return `Currently ingested files (already loaded — do not ask the user to provide them again, just query them with the available tools):
${lines}

User question: ${userQuery}`;
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
  history: CoreMessage[],
): Promise<{ answer: AgentAnswer; history: CoreMessage[] }> {
  const userMessage: CoreMessage = {
    role: "user",
    content: buildPrompt(userQuery),
  };
  const result = await generateText({
    model: openai("gpt-4o"),
    maxSteps: 10,
    system: SYSTEM_PROMPT,
    tools: {
      ingestFile,
      searchDocuments,
      analyzeBidItems,
      queryPlanSet,
    },
    messages: [...history, userMessage],
  });
  const nextHistory: CoreMessage[] = [
    ...history,
    userMessage,
    ...result.response.messages,
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

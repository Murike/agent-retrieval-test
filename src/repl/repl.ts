import repl from "node:repl";
import type { CoreMessage } from "ai";
import { ingest, listIngested } from "../ingestion/ingestor.js";
import { runAgent } from "../agent/agent.js";
import { ChatHistory } from "../chat/history.js";

function printHelp(): void {
  console.log(
    [
      "Commands:",
      "  /help              show this help",
      "  /quit              exit",
      "  /files             list ingested files",
      "  /ingest <path>     ingest a CSV or PDF file",
      "  /reset             clear conversation history",
      "  /history           show conversation message count",
      "  <free text>        ask the agent a question",
    ].join("\n"),
  );
}

function printFiles(): void {
  const files = listIngested();
  if (files.length === 0) {
    console.log("No files ingested yet.");
    return;
  }
  for (const f of files) {
    console.log(
      `  ${f.path} [${f.type}] — ${f.chunkCount} chunks, ingested ${f.ingestedAt.toISOString()}`,
    );
  }
}

async function handleCommand(
  line: string,
  server: repl.REPLServer,
): Promise<void> {
  const [cmd, ...rest] = line.split(/\s+/);
  const arg = rest.join(" ").trim();

  if (cmd === "/help") {
    printHelp();
    return;
  }
  if (cmd === "/quit") {
    server.close();
    return;
  }
  if (cmd === "/files") {
    printFiles();
    return;
  }
  if (cmd === "/ingest") {
    if (!arg) {
      console.log("Usage: /ingest <path>");
      return;
    }
    const { file, caveats } = await ingest(arg);
    console.log(
      `Ingested ${file.path} [${file.type}] — ${file.chunkCount} chunks.`,
    );
    if (caveats.length > 0) {
      console.log("Caveats:");
      for (const c of caveats) console.log(`  - ${c}`);
    }
    return;
  }
  console.log(`Unknown command: ${cmd}. Type /help.`);
}

export function startRepl(): void {
  const history = new ChatHistory();

  const server = repl.start({
    prompt: "> ",
    ignoreUndefined: true,
    eval: async (input, _context, _filename, callback) => {
      try {
        const line = input.trim();

        if (!line) {
          callback(null, undefined);
          return;
        }

        if (line === "/reset") {
          history.reset();
          console.log("Conversation history cleared.");
          callback(null, undefined);
          return;
        }

        if (line === "/history") {
          console.log(`Conversation has ${history.size()} messages.`);
          callback(null, undefined);
          return;
        }

        if (line.startsWith("/")) {
          await handleCommand(line, server);
          callback(null, undefined);
          return;
        }

        const { answer, history: nextHistory } = await runAgent(
          line,
          history.get(),
        );
        history.replace(nextHistory);
        console.log(answer.answer);
        callback(null, undefined);
      } catch (error) {
        callback(error as Error, undefined);
      }
    },
  });
}

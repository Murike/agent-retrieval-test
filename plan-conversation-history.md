# Implementation Plan — Add Conversation History to the REPL

## Goal

Make REPL follow-up turns build on prior context. Today `runAgent` is invoked stateless per line, so the model treats every turn as a first turn.

## Approach

Switch `generateText` from `prompt: string` to `messages: CoreMessage[]`. Accumulate history in REPL scope. Append `result.response.messages` after each call so tool calls and tool results are preserved across turns.

---

## Steps

### 1. Change `runAgent` signature

File: `src/agent/agent.ts`

- Import `CoreMessage` from `"ai"`.
- Change the function signature to:
  ```ts
  export async function runAgent(
    userQuery: string,
    history: CoreMessage[],
  ): Promise<{ answer: AgentAnswer; history: CoreMessage[] }>
  ```
- In the body, replace this:
  ```ts
  const result = await generateText({
    model: openai("gpt-4o"),
    maxSteps: 10,
    system: SYSTEM_PROMPT,
    tools: { ingestFile, searchDocuments, analyzeNumericFields, queryPdf },
    prompt: buildPrompt(userQuery),
  });
  ```
  with this:
  ```ts
  const userMessage: CoreMessage = {
    role: "user",
    content: buildPrompt(userQuery),
  };
  const result = await generateText({
    model: openai("gpt-4o"),
    maxSteps: 10,
    system: SYSTEM_PROMPT,
    tools: { ingestFile, searchDocuments, analyzeNumericFields, queryPdf },
    messages: [...history, userMessage],
  });
  const nextHistory: CoreMessage[] = [
    ...history,
    userMessage,
    ...result.response.messages,
  ];
  ```
- Change every `return <AgentAnswer>;` in the function to `return { answer: <AgentAnswer>, history: nextHistory };`.

### 2. Maintain history in the REPL

File: `src/repl/repl.ts`

- Import `CoreMessage` from `"ai"`.
- Inside `startRepl`, before `repl.start(...)`, declare:
  ```ts
  let history: CoreMessage[] = [];
  ```
- In the `eval` handler, replace:
  ```ts
  const answer = await runAgent(line);
  console.log(answer.answer);
  ```
  with:
  ```ts
  const { answer, history: nextHistory } = await runAgent(line, history);
  history = nextHistory;
  console.log(answer.answer);
  ```

### 3. Add `/reset` command

File: `src/repl/repl.ts`

- The cleanest way: handle `/reset` inline in the `eval` handler (since `handleCommand` does not currently have access to `history`). Before the existing `if (line.startsWith("/"))` block, add:
  ```ts
  if (line === "/reset") {
    history = [];
    console.log("Conversation history cleared.");
    callback(null, undefined);
    return;
  }
  ```
- Update `printHelp` to add the line:
  ```
  "  /reset             clear conversation history",
  ```

### 4. Update tests

File: `tests/runAgent.test.ts`

- Change both calls from `runAgent("…")` to `runAgent("…", [])`.
- Change the assertions from `expect(answer.answer)…` to first destructure: `const { answer } = await runAgent("…", []);` then use `answer` as before.
- The mocked `generateText` currently returns only `{ text: … }`. Since the new code reads `result.response.messages`, update the mock to also return `response: { messages: [] }`. Example:
  ```ts
  generateText: vi.fn(async () => ({
    text: JSON.stringify({ … }),
    response: { messages: [] },
  })),
  ```
  Apply the same shape to the `mockResolvedValueOnce` in the second test.

### 5. Verify

Run in order, all must pass:

1. `npm run typecheck` — 0 TypeScript errors.
2. `npm test` — all vitest tests pass.
3. Manual: `npm run dev`, then:
   - `/ingest <some-csv-path>`
   - Ask a question about the data.
   - Ask a short follow-up like "and which had the lowest unit price?" that only makes sense given the prior turn.
   - Confirm the second answer references the prior context (does not ask the user to repeat themselves and does not ignore the previous topic).
   - Run `/reset`, then ask the follow-up again. Confirm the model now lacks context.

---

## Critical implementation notes

- **Push `result.response.messages`, NOT `{ role: "assistant", content: result.text }`.** With `maxSteps: 10` the agent emits tool-call and tool-result messages between user input and final text. Dropping them means the next turn cannot see what tools returned, and the assistant will likely re-call tools redundantly or fabricate answers.
- **`result.response.messages` exists in AI SDK v4.** If the installed version's type does not have this field, check `node_modules/ai/dist/index.d.ts` for the equivalent (older names include `responseMessages`). Adjust accordingly. Do not invent a field name.
- **Do not change `SYSTEM_PROMPT`.** The JSON-only output rule still applies; prior assistant turns showing as JSON in history is fine — the model treats them as previous answers.
- **Do not change `buildPrompt` in this pass.** Leaving the file-list/schema preface embedded in each user message is acceptable for v1. See "Optional follow-ups" below.

---

## Optional follow-ups (not part of this task)

- **Refresh preface each turn.** Move the ingested-files list and schema preface out of `buildPrompt` and into the `system` parameter (rebuilt fresh each call), so historical user messages do not carry stale ingestion state. If a file is ingested mid-conversation, the model immediately sees it.
- **Cap history.** Truncate to the last N turns, or summarize older turns, to bound token growth in long sessions.
- **Persist history.** Save to a JSON file on REPL exit; reload on start.

---

## Out of scope

- Any change to tools, ingestion, vector store, or the JSON output schema.
- Changing the model or `maxSteps`.
- Multi-session / multi-user state.

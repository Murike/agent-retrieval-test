import "dotenv/config";
import { startRepl } from "./repl/repl.js";

function main(): void {
  if (!process.env.OPENAI_API_KEY) {
    console.error("Error: OPENAI_API_KEY is not set. Add it to .env or your environment.");
    process.exit(1);
  }

  console.log("Construction Estimating Agent");
  console.log("Type /help for commands, or ask a question.\n");

  startRepl();
}

main();

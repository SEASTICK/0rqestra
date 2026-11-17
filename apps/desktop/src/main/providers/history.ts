import type { ChatTurn } from "./types";

// Phase 1 keeps the conversation in 0rqestra and sends recent turns with each message, instead of
// relying on each tool's own session store. That works the same for every provider, survives a
// restart, and lets the user switch model in the middle of a conversation.

export const MAX_MESSAGE_CHARS = 20_000;
export const MAX_HISTORY_CHARS = 24_000;
export const MAX_HISTORY_TURNS = 20;

const PREAMBLE =
  "You are the Manager in 0rqestra, a desktop app where one Manager leads a team of AI agents. " +
  "In this version you answer the user directly in the chat. Reply in the language the user writes in. " +
  "Do not claim to have run tools, read files, or contacted other agents.";

export function buildPrompt(history: ChatTurn[], text: string): string {
  const kept: string[] = [];
  let used = 0;
  for (const turn of history.slice(-MAX_HISTORY_TURNS).reverse()) {
    const line = `${turn.role === "user" ? "User" : "Manager"}: ${turn.text.trim()}`;
    if (used + line.length > MAX_HISTORY_CHARS) break;
    kept.unshift(line);
    used += line.length;
  }
  const parts = [PREAMBLE];
  if (kept.length) parts.push(`Conversation so far:\n${kept.join("\n\n")}`);
  parts.push(`User: ${text.trim()}`);
  return parts.join("\n\n");
}

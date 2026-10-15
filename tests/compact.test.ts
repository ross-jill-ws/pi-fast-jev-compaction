import assert from "node:assert/strict";
import { test } from "node:test";
import { compact } from "../extensions/jev/compact.ts";
import type { JevTransport } from "../extensions/jev/request.ts";
import type { JevAsker, Message } from "../extensions/jev/types.ts";

/**
 * Two unpinned reads. Question tokens are 121 each and the fitted state is 319,
 * so a 589-token request holds both questions with a 20-token envelope and only
 * one of them with a 40-token envelope.
 */
const messages: Message[] = [
  { role: "user", text: "Keep the task.", toolUses: [] },
  { role: "assistant", text: "", toolUses: [{ tool_use_id: "a", tool: "read", input: { path: "a.ts" } }] },
  { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "a", text: "x".repeat(40) }] },
  { role: "assistant", text: "", toolUses: [{ tool_use_id: "b", tool: "read", input: { path: "b.ts" } }] },
  { role: "user", text: "", toolUses: [], toolResults: [{ tool_use_id: "b", text: "y".repeat(40) }] },
];

async function asks(transport: JevTransport): Promise<number> {
  let count = 0;
  const asker: JevAsker = {
    async ask(_state, questions) {
      count += 1;
      return {
        answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "noul" as const, noul: 0.9 }])),
      };
    },
  };
  await compact(messages, asker, {
    goal: "ship it",
    preserveRecentMessages: 0,
    maxRequestTokens: 589,
    transport,
  });
  return count;
}

test("OpenRouter compaction asks twice when the same transcript still fits in one System One request", async () => {
  assert.equal(await asks("typesafe"), 1);
  assert.equal(await asks("openrouter"), 2);
});

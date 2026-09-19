/** Test helpers: pi-shaped LLM messages and a fake jev asker. */
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import type { JevAsker, JevQuestions } from "../extensions/jev/types.ts";

let ts = 1_700_000_000_000;
let n = 0;

export function user(text: string): UserMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: ts++ };
}

export function assistant(text: string, calls: { name: string; args: Record<string, unknown>; id?: string }[] = []): AssistantMessage {
  return {
    role: "assistant",
    content: [
      ...(text ? [{ type: "text" as const, text }] : []),
      ...calls.map((c) => ({ type: "toolCall" as const, id: c.id ?? `call_${++n}`, name: c.name, arguments: c.args })),
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp: ts++,
  } as AssistantMessage;
}

export function lastCallId(message: AssistantMessage, index = 0): string {
  const calls = message.content.filter((b) => b.type === "toolCall");
  return (calls[index] as { id: string }).id;
}

export function toolResult(toolCallId: string, toolName: string, text: string, isError = false): ToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError, timestamp: ts++ };
}

export function toolResultWithImage(toolCallId: string, toolName: string, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [
      { type: "text", text },
      { type: "image", data: "AAAA", mimeType: "image/png" },
    ],
    isError: false,
    timestamp: ts++,
  };
}

/** A pi-style transcript: task, read a file, run tests (fail), edit, tests pass, assistant summary. */
export function transcript(fileChars = 3000): Message[] {
  const file = "export const a = 1;\n".repeat(Math.ceil(fileChars / 20));
  const a1 = assistant("", [{ name: "read", args: { path: "src/a.ts" } }]);
  const a2 = assistant("Running the tests.", [{ name: "bash", args: { command: "npm test" } }]);
  const a3 = assistant("Fixing the off-by-one.", [{ name: "edit", args: { path: "src/a.ts", oldText: "a = 1", newText: "a = 2" } }]);
  const a4 = assistant("", [{ name: "bash", args: { command: "npm test" } }]);
  return [
    user("Fix the failing test. Never touch src/generated."),
    a1,
    toolResult(lastCallId(a1), "read", file),
    a2,
    toolResult(lastCallId(a2), "bash", "FAIL src/a.test.ts\n  expected 2 to be 1\n".repeat(20), true),
    a3,
    toolResult(lastCallId(a3), "edit", "Edited src/a.ts"),
    a4,
    toolResult(lastCallId(a4), "bash", "PASS src/a.test.ts (1 test)"),
    assistant("All green. The fix changed a from 1 to 2."),
  ];
}

export type Seen = { state: unknown; questions: string[] };

/** Answers every question with `answer(name)`; records what it was asked. */
export function fakeJev(answer: (name: string) => number, seen: Seen[] = []): JevAsker {
  return {
    async ask(state, questions: JevQuestions) {
      seen.push({ state, questions: Object.keys(questions) });
      return {
        answers: Object.fromEntries(Object.keys(questions).map((key) => [key, { type: "noul" as const, noul: answer(key) }])),
        usage: { input_tokens: 100, output_tokens: Object.keys(questions).length },
      };
    },
  };
}

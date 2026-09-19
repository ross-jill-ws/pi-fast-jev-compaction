import assert from "node:assert/strict";
import { test } from "node:test";
import { actionsFrom, applyActions, contentText, fileOperations, messagesChars, normalizeMessages, toJevMessages } from "../extensions/adapter.ts";
import { compact } from "../extensions/jev/compact.ts";
import { renderSummary, renderTranscript } from "../extensions/render.ts";
import { assistant, fakeJev, lastCallId, toolResult, toolResultWithImage, transcript, user } from "./helpers.ts";

test("toJevMessages maps pi messages 1:1 and pairs calls with results", async () => {
  const messages = transcript();
  const jev = toJevMessages(messages);
  assert.equal(jev.length, messages.length);
  assert.equal(jev[0]!.role, "user");
  assert.equal(jev[1]!.toolUses[0]!.tool, "read");
  assert.deepEqual(jev[1]!.toolUses[0]!.input, { path: "src/a.ts" });
  assert.equal(jev[2]!.toolResults![0]!.tool_use_id, jev[1]!.toolUses[0]!.tool_use_id);
  assert.equal(jev[4]!.toolResults![0]!.isError, true);

  const run = await compact(jev, fakeJev(() => 0.9), { preserveRecentMessages: 0 });
  assert.equal(run.calls.length, 4);
  assert.deepEqual(run.calls.map((c) => c.tool), ["read", "bash", "edit", "bash"]);
  assert.equal(run.stats.jevInputTokens, 100);
});

test("applyActions drops calls with their results and truncates dropped results, text untouched", async () => {
  const messages = transcript();
  const jev = toJevMessages(messages);
  // t1 read: drop call+result; t2 bash(fail): keep call, truncate result; t3 edit: keep; t4 bash(pass): keep
  const run = await compact(
    jev,
    fakeJev((name) => {
      if (name.endsWith("_t1")) return 0.1;
      if (name === "result_t2") return 0.2;
      return 0.9;
    }),
    { preserveRecentMessages: 0, truncateHeadChars: 50 },
  );
  assert.deepEqual(run.decisions.map((d) => d.action), ["drop_call", "drop_result", "keep", "keep"]);
  const actions = actionsFrom(run.decisions, run.calls);
  const out = applyActions(messages, actions, 50);
  // the read assistant message had no text -> removed together with its result
  assert.equal(out.messages.length, messages.length - 2);
  assert.equal(out.removed, 2);
  assert.equal(out.rewritten, 1);
  assert.equal(out.messages[0], messages[0]); // untouched objects are identical
  const truncated = out.messages[2]!;
  if (truncated.role !== "toolResult") throw new Error(`expected toolResult, got `);
  const text = contentText(truncated.content);
  assert.match(text, /^FAIL src\/a\.test\.ts/);
  assert.match(text, /\[pi-fast-jev-compaction truncated \d+ chars of this tool result \(error\); re-run the tool if needed\]$/);
  assert.equal(text.length < 200, true);
  // assistant text kept verbatim
  const second = out.messages[1]!;
  if (second.role !== "assistant") throw new Error(`expected assistant, got `);
  assert.equal(contentText(second.content), "Running the tests.");
  // no result without its call and vice versa
  const callIds = new Set<string>();
  for (const m of out.messages) if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") callIds.add(b.id);
  for (const m of out.messages) if (m.role === "toolResult") assert.equal(callIds.has(m.toolCallId), true);
});

test("dropping one of several calls in one assistant message keeps the message", async () => {
  const a = assistant("Reading both files.", [
    { name: "read", args: { path: "a.ts" } },
    { name: "read", args: { path: "b.ts" } },
  ]);
  const messages = [user("look at a and b"), a, toolResult(lastCallId(a, 0), "read", "A".repeat(500)), toolResult(lastCallId(a, 1), "read", "B".repeat(500)), assistant("done")];
  const run = await compact(toJevMessages(messages), fakeJev((name) => (name.endsWith("_t1") ? 0.0 : 0.9)), { preserveRecentMessages: 0 });
  const out = applyActions(messages, actionsFrom(run.decisions, run.calls), 100);
  assert.equal(out.messages.length, 4);
  const kept = out.messages[1]!;
  assert.equal(kept.role, "assistant");
  assert.equal(kept.content.filter((b) => b.type === "toolCall").length, 1);
  assert.equal(out.messages[2]!.role, "toolResult");
  assert.equal((out.messages[2] as { toolCallId: string }).toolCallId, lastCallId(a, 1));
});

test("normalizeMessages replaces images with a note and drops thinking-only assistant messages", () => {
  const a = assistant("", [{ name: "bash", args: { command: "screenshot" } }]);
  const thinkingOnly = { ...assistant("x"), content: [{ type: "thinking" as const, thinking: "hmm" }] };
  const withThinking = { ...assistant("answer"), content: [{ type: "thinking" as const, thinking: "hmm" }, { type: "text" as const, text: "answer" }] };
  const out = normalizeMessages([user("go"), a, toolResultWithImage(lastCallId(a), "bash", "shot taken"), thinkingOnly, withThinking]);
  assert.equal(out.length, 4);
  const result = out[2] as { content: { type: string; text?: string }[] };
  assert.deepEqual(result.content, [{ type: "text", text: "shot taken\n[image omitted]" }]);
  const last = out[3] as { content: { type: string }[] };
  assert.deepEqual(last.content.map((b) => b.type), ["text"]);
});

test("renderTranscript keeps full kept tool results and names the tool", () => {
  const messages = transcript(5000);
  const text = renderTranscript(messages);
  assert.match(text, /^\[User\]: Fix the failing test/);
  assert.match(text, /\[Assistant tool calls\]: read\(path="src\/a\.ts"\)/);
  assert.match(text, /\[Tool result: read\]: export const a = 1;/);
  assert.match(text, /\[Tool result \(error\): bash\]: FAIL/);
  // pi's own serializer would cut at 2000 chars; ours keeps it all
  assert.equal(text.includes("more characters truncated"), false);
  assert.equal(text.length > 5000, true);
});

test("renderSummary carries a pi summary and file lists", () => {
  const summary = renderSummary({
    transcript: "[User]: hi",
    stats: { messages: 1, callsKept: 2, resultsTruncated: 1, callsDropped: 3, truncateHeadChars: 300 },
    previousSummary: "## Goal\nold stuff",
    readFiles: ["a.ts"],
    modifiedFiles: ["b.ts"],
  });
  assert.match(summary, /^Verbatim history kept by pi-fast-jev-compaction/);
  assert.match(summary, /2 tool calls kept in full, 1 results truncated to their first 300 chars, 3 calls removed/);
  assert.match(summary, /## Summary of the history before this transcript\n\n## Goal\nold stuff/);
  assert.match(summary, /## Transcript\n\n\[User\]: hi/);
  assert.match(summary, /<read-files>\na\.ts\n<\/read-files>\n\n<modified-files>\nb\.ts\n<\/modified-files>$/);
});

test("fileOperations and messagesChars", () => {
  const messages = transcript(100);
  assert.deepEqual(fileOperations(messages), { readFiles: [], modifiedFiles: ["src/a.ts"] });
  assert.equal(messagesChars(messages) > 100, true);
});

test("no tool calls means no jev request and everything kept", async () => {
  const messages = [user("hi"), assistant("hello"), user("bye")];
  const seen: { state: unknown; questions: string[] }[] = [];
  const run = await compact(toJevMessages(messages), fakeJev(() => 0, seen), {});
  assert.equal(seen.length, 0);
  assert.equal(run.stats.requests, 0);
  const out = applyActions(messages, actionsFrom(run.decisions, run.calls), 300);
  assert.deepEqual(out.messages, messages);
});

test("buildGoal keeps the original task and skips trivial recent prompts", async () => {
  const { buildGoal } = await import("../extensions/goal.ts");
  const goal = buildGoal([
    "Refactor main.ts and tui-renderer.ts; I want a plan to untangle the run modes.",
    "AgentSession looks like a good idea, can we move the shared logic there and keep the TUI thin?",
    "ls",
    "what did i just execute?",
    "ok",
  ]);
  assert.match(goal, /^Original task: Refactor main\.ts/);
  assert.match(goal, /- AgentSession looks like a good idea/);
  assert.match(goal, /- ok$/);
  assert.equal(goal.includes("- ls"), false);
  assert.equal(buildGoal([]), "");
  assert.equal(buildGoal(["only task"]), "Original task: only task");
});

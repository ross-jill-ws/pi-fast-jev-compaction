/**
 * Bridges pi's LLM message model and the vendored jev compaction core.
 *
 * pi messages (after `convertToLlm`) are `user`, `assistant`, `toolResult` and
 * `system`. The jev core wants Claude Code's shape: assistant messages carry
 * `toolUses`, user messages carry `toolResults`. The mapping is 1:1 by index,
 * so decisions made on jev's view can be applied straight back to pi's.
 */

import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { truncatedResultText } from "./jev/compact.ts";
import type { CallDecision, Message as JevMessage, ToolCall as JevCall } from "./jev/types.ts";

export const IMAGE_NOTE = "[image omitted]";

type Block = TextContent | ImageContent | ThinkingContent | ToolCall;

/** Text of a content list, images noted, thinking and tool calls skipped. */
export function contentText(content: string | readonly Block[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "image") parts.push(IMAGE_NOTE);
  }
  return parts.join("\n");
}

/**
 * Makes LLM messages safe to store and re-prune later: images become a note,
 * thinking blocks are dropped (they are never rendered into the summary),
 * assistant messages left with nothing are removed.
 */
export function normalizeMessages(messages: readonly Message[]): Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      if (typeof message.content === "string") {
        out.push(message);
        continue;
      }
      const hasImage = message.content.some((b) => b.type === "image");
      out.push(
        hasImage
          ? { ...message, content: [{ type: "text", text: contentText(message.content) }] }
          : message,
      );
    } else if (message.role === "assistant") {
      const content = message.content.filter((b) => b.type !== "thinking");
      if (content.length === 0) continue;
      out.push(content.length === message.content.length ? message : { ...message, content });
    } else if (message.role === "toolResult") {
      const hasImage = message.content.some((b) => b.type === "image");
      out.push(
        hasImage
          ? { ...message, content: [{ type: "text", text: contentText(message.content) }] }
          : message,
      );
    } else {
      out.push(message);
    }
  }
  return out;
}

/** Converts pi LLM messages into the jev core's message shape, index for index. */
export function toJevMessages(messages: readonly Message[]): JevMessage[] {
  return messages.map((message): JevMessage => {
    switch (message.role) {
      case "assistant":
        return {
          role: "assistant",
          text: contentText(message.content),
          toolUses: message.content
            .filter((b): b is ToolCall => b.type === "toolCall")
            .map((call) => ({
              tool_use_id: call.id,
              tool: call.name,
              input: (call.arguments ?? {}) as Record<string, unknown>,
            })),
        };
      case "toolResult":
        return {
          role: "user",
          text: "",
          toolUses: [],
          toolResults: [
            {
              tool_use_id: message.toolCallId,
              text: contentText(message.content),
              isError: message.isError,
            },
          ],
        };
      case "user":
        return { role: "user", text: contentText(message.content), toolUses: [] };
      default:
        // system messages never reach compaction in pi, but keep the mapping total
        return { role: "user", text: contentText((message as UserMessage).content), toolUses: [] };
    }
  });
}

export type Action = "drop_result" | "drop_call";
export type ActionMap = Map<string, Action>;

/** Per tool-call-id actions from jev decisions (`keep` produces no entry). */
export function actionsFrom(decisions: readonly CallDecision[], calls: readonly JevCall[]): ActionMap {
  const byId = new Map(calls.map((call) => [call.id, call.tool_use_id]));
  const actions: ActionMap = new Map();
  for (const decision of decisions) {
    const toolCallId = byId.get(decision.id);
    if (toolCallId && decision.action !== "keep") actions.set(toolCallId, decision.action);
  }
  return actions;
}

export interface ApplyOutcome {
  messages: Message[];
  /** Messages removed entirely (dropped calls whose assistant message had no text, dropped results). */
  removed: number;
  /** Messages rewritten (tool calls filtered or results truncated). */
  rewritten: number;
}

/**
 * Applies jev's decisions to pi messages. A dropped call disappears from its
 * assistant message together with its tool result message; a dropped result
 * keeps its first `headChars` characters plus a note. Text is never touched.
 * Untouched messages are returned as the same objects.
 */
export function applyActions(messages: readonly Message[], actions: ActionMap, headChars: number): ApplyOutcome {
  const out: Message[] = [];
  let removed = 0;
  let rewritten = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      const dropped = message.content.some((b) => b.type === "toolCall" && actions.get(b.id) === "drop_call");
      if (!dropped) {
        out.push(message);
        continue;
      }
      const content = message.content.filter((b) => !(b.type === "toolCall" && actions.get(b.id) === "drop_call"));
      const hasSubstance = content.some((b) => b.type === "text" ? b.text.trim().length > 0 : b.type === "toolCall");
      if (!hasSubstance) {
        removed++;
        continue;
      }
      rewritten++;
      out.push({ ...message, content } as AssistantMessage);
    } else if (message.role === "toolResult") {
      const action = actions.get(message.toolCallId);
      if (action === "drop_call") {
        removed++;
        continue;
      }
      if (action === "drop_result") {
        const original = contentText(message.content);
        const text = truncatedResultText(original, message.isError, headChars);
        if (text !== original) {
          rewritten++;
          out.push({ ...message, content: [{ type: "text", text }] } as ToolResultMessage);
          continue;
        }
      }
      out.push(message);
    } else {
      out.push(message);
    }
  }
  return { messages: out, removed, rewritten };
}

/** Characters of text, tool arguments and tool output pi messages hold (the jev core's measure). */
export function messagesChars(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") total += block.text.length;
        else if (block.type === "toolCall") total += JSON.stringify(block.arguments ?? {}).length;
      }
    } else if (message.role === "toolResult" || message.role === "user") {
      total += contentText(message.content).length;
    }
  }
  return total;
}

/** File paths read and modified by kept tool calls (mirrors pi's read/modified-files footer). */
export function fileOperations(messages: readonly Message[]): { readFiles: string[]; modifiedFiles: string[] } {
  const read = new Set<string>();
  const modified = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const path = (block.arguments as Record<string, unknown> | undefined)?.path;
      if (typeof path !== "string" || !path) continue;
      if (block.name === "read") read.add(path);
      else if (block.name === "write" || block.name === "edit") modified.add(path);
    }
  }
  for (const path of modified) read.delete(path);
  return { readFiles: [...read].sort(), modifiedFiles: [...modified].sort() };
}

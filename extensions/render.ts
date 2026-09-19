/**
 * Renders the pruned pi messages into the text that becomes pi's compaction
 * "summary". Unlike pi's own serializer, kept tool results are never
 * truncated here: what jev decided to keep stays verbatim.
 */

import type { Message } from "@earendil-works/pi-ai";
import { contentText } from "./adapter.ts";

export function renderTranscript(messages: readonly Message[]): string {
  const parts: string[] = [];
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "user") {
      const text = contentText(message.content);
      if (text.trim()) parts.push(`[User]: ${text}`);
    } else if (message.role === "assistant") {
      const calls: string[] = [];
      for (const block of message.content) {
        if (block.type !== "toolCall") continue;
        toolNames.set(block.id, block.name);
        const args = Object.entries((block.arguments ?? {}) as Record<string, unknown>)
          .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
          .join(", ");
        calls.push(`${block.name}(${args})`);
      }
      const text = contentText(message.content);
      if (text.trim()) parts.push(`[Assistant]: ${text}`);
      if (calls.length > 0) parts.push(`[Assistant tool calls]: ${calls.join("; ")}`);
    } else if (message.role === "toolResult") {
      const name = message.toolName || toolNames.get(message.toolCallId) || "tool";
      const text = contentText(message.content);
      parts.push(`[Tool result${message.isError ? " (error)" : ""}: ${name}]: ${text.trim() ? text : "(empty)"}`);
    }
  }
  return parts.join("\n\n");
}

export interface SummaryStats {
  messages: number;
  callsKept: number;
  resultsTruncated: number;
  callsDropped: number;
  truncateHeadChars: number;
}

export interface SummaryInput {
  transcript: string;
  stats: SummaryStats;
  /** A previous pi-generated (non-jev) summary that still describes older history. */
  previousSummary?: string;
  readFiles: string[];
  modifiedFiles: string[];
}

export function renderSummary(input: SummaryInput): string {
  const { stats } = input;
  const header =
    `Verbatim history kept by pi-fast-jev-compaction (no LLM summary). Earlier user and assistant messages ` +
    `appear exactly as written; only tool calls and tool outputs that jev judged no longer needed were ` +
    `removed or truncated. ${stats.messages} messages; ${stats.callsKept} tool calls kept in full, ` +
    `${stats.resultsTruncated} results truncated to their first ${stats.truncateHeadChars} chars, ` +
    `${stats.callsDropped} calls removed. Re-run a tool if you need an output that was truncated.`;

  const sections: string[] = [header];
  if (input.previousSummary?.trim()) {
    sections.push(`## Summary of the history before this transcript\n\n${input.previousSummary.trim()}`);
    sections.push(`## Transcript\n\n${input.transcript}`);
  } else {
    sections.push(input.transcript);
  }

  const files: string[] = [];
  if (input.readFiles.length > 0) files.push(`<read-files>\n${input.readFiles.join("\n")}\n</read-files>`);
  if (input.modifiedFiles.length > 0) {
    files.push(`<modified-files>\n${input.modifiedFiles.join("\n")}\n</modified-files>`);
  }
  if (files.length > 0) sections.push(files.join("\n\n"));

  return sections.join("\n\n");
}

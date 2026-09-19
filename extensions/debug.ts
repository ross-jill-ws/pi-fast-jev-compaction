/**
 * Debug bundles: everything one compaction saw and decided, written to a
 * folder so pi's default `/compact` and `/compact-jev` can be compared.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallDecision, CompactResult, ToolCall } from "./jev/types.ts";

export function stamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export interface Bundle {
  dir: string;
  text(name: string, content: string): void;
  json(name: string, value: unknown): void;
}

export function createBundle(baseDir: string, label: string): Bundle {
  const dir = join(baseDir, `${stamp()}_${label}`);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    text(name, content) {
      writeFileSync(join(dir, name), content, "utf-8");
    },
    json(name, value) {
      writeFileSync(join(dir, name), JSON.stringify(value, null, 2), "utf-8");
    },
  };
}

export interface SizeRow {
  label: string;
  messages: number | string;
  chars: number;
  tokens: number;
  /** Reduction of the replaced context, 0..1; undefined when not applicable. */
  ratio?: number;
  ms?: number;
  note?: string;
}

export interface ReportInput {
  when: string;
  mode: "apply" | "dry-run";
  reason: string;
  force: boolean;
  sessionFile?: string;
  model?: string;
  jevModel: string;
  config: Record<string, unknown>;
  input: {
    newMessages: number;
    turnPrefixMessages: number;
    previousJevMessages: number;
    previousSummaryChars: number;
    previousSummaryFrom?: "jev" | "pi" | "none";
    contextTokensBefore: number;
    customInstructions?: string;
  };
  rows: SizeRow[];
  jev?: {
    stats: CompactResult["stats"];
    decisions: CallDecision[];
    calls: ToolCall[];
    error?: string;
  };
  defaultSummary?: DefaultSummaryInfo;
  timing?: TimingInfo;
  outcome: { applied: boolean; summary: string };
}

/** pi's default summary of the same input, when it was (or will be) computed for comparison. */
export interface DefaultSummaryInfo {
  model: string;
  ms: number;
  chars: number;
  error?: string;
  /** How it related to the compaction: awaited (dry run), still running, done in the background, or skipped. */
  status: "awaited" | "pending" | "background" | "skipped";
  /** Why it was skipped, when status is "skipped". */
  reason?: string;
}

/** Where the hook's time went. All in milliseconds. */
export interface TimingInfo {
  /** convertToLlm + normalize + goal, before jev is asked */
  prepMs: number;
  /** jev requests (wall time) */
  jevMs: number;
  jevRequests: number;
  /** applying decisions + rendering the summary */
  applyMs: number;
  /** everything pi waited for in the hook (what the user experiences) */
  hookMs: number;
}

function pct(ratio: number | undefined): string {
  return ratio === undefined ? "-" : `${(ratio * 100).toFixed(1)}%`;
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

export function decisionLines(decisions: readonly CallDecision[], calls: readonly ToolCall[]): string[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  return decisions.map((d) => {
    const call = byId.get(d.id);
    const input = call ? JSON.stringify(call.input) : "";
    const shortInput = input.length > 90 ? `${input.slice(0, 89)}…` : input;
    const size = call ? `${n(call.resultChars)}ch${call.isError ? " error" : ""}` : "";
    return `${d.id.padEnd(5)} ${d.action.padEnd(11)} call=${d.keepCall.toFixed(2)} result=${d.keepResult.toFixed(2)}  ${d.tool}(${shortInput}) → ${size}`;
  });
}

export function buildReport(r: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# pi-fast-jev-compaction report`);
  lines.push("");
  lines.push(`- when: ${r.when}`);
  lines.push(`- mode: ${r.mode}${r.force ? " (force)" : ""}, reason: ${r.reason}`);
  if (r.sessionFile) lines.push(`- session: ${r.sessionFile}`);
  lines.push(`- session model: ${r.model ?? "(none)"}; jev model: ${r.jevModel}`);
  lines.push(`- config: ${JSON.stringify(r.config)}`);
  lines.push("");
  lines.push(`## Input`);
  lines.push("");
  lines.push(`- context tokens before (pi estimate): ${n(r.input.contextTokensBefore)}`);
  lines.push(`- new messages to compact: ${r.input.newMessages}${r.input.turnPrefixMessages ? ` (+${r.input.turnPrefixMessages} split-turn prefix)` : ""}`);
  lines.push(
    `- previous compaction: ${r.input.previousSummaryFrom ?? "none"}` +
      (r.input.previousJevMessages ? ` (${r.input.previousJevMessages} pruned messages re-evaluated)` : "") +
      (r.input.previousSummaryChars ? ` (${n(r.input.previousSummaryChars)} chars of summary in context)` : ""),
  );
  if (r.input.customInstructions) lines.push(`- custom instructions: ${r.input.customInstructions}`);
  lines.push("");
  lines.push(`## Sizes`);
  lines.push("");
  lines.push(`| what | messages | chars | est. tokens | reduction of replaced context | time |`);
  lines.push(`|---|---:|---:|---:|---:|---:|`);
  for (const row of r.rows) {
    lines.push(
      `| ${row.label}${row.note ? ` (${row.note})` : ""} | ${row.messages} | ${n(row.chars)} | ${n(row.tokens)} | ${pct(row.ratio)} | ${row.ms === undefined ? "-" : `${n(row.ms)} ms`} |`,
    );
  }
  lines.push("");
  if (r.jev) {
    const s = r.jev.stats;
    lines.push(`## jev`);
    lines.push("");
    if (r.jev.error) lines.push(`- error: ${r.jev.error}`);
    lines.push(
      `- tool calls: ${s.calls} total; ${s.kept} kept, ${s.resultsDropped} results truncated, ${s.callsDropped} calls removed, ${s.pinned} pinned`,
    );
    lines.push(`- state: ~${n(s.stateTokens)} tokens (${s.stateStage || "no request"}), ${s.requests} request(s), ${n(s.ms)} ms`);
    lines.push(`- jev usage: ${n(s.jevInputTokens)} input / ${n(s.jevOutputTokens)} output tokens`);
    lines.push("");
    lines.push("```");
    lines.push(...(r.jev.decisions.length ? decisionLines(r.jev.decisions, r.jev.calls) : ["(no tool calls)"]));
    lines.push("```");
    lines.push("");
  }
  if (r.timing) {
    const t = r.timing;
    lines.push(`## Timing`);
    lines.push("");
    lines.push(`| step | ms |`);
    lines.push(`|---|---:|`);
    lines.push(`| prepare candidates (convert, normalize, goal) | ${n(t.prepMs)} |`);
    lines.push(`| jev (${t.jevRequests} request${t.jevRequests === 1 ? "" : "s"}) | ${n(t.jevMs)} |`);
    lines.push(`| apply decisions + render | ${n(t.applyMs)} |`);
    lines.push(`| **hook total (what pi waited for)** | **${n(t.hookMs)}** |`);
    if (r.defaultSummary && !r.defaultSummary.error && r.defaultSummary.status !== "skipped" && r.defaultSummary.status !== "pending") {
      lines.push(`| pi default summary, ${r.defaultSummary.model} (${r.defaultSummary.status === "background" ? "background, not waited for" : "awaited by the dry run"}) | ${n(r.defaultSummary.ms)} |`);
    }
    lines.push("");
  }
  if (r.defaultSummary) {
    const d = r.defaultSummary;
    lines.push(`## pi default summary`);
    lines.push("");
    if (d.status === "skipped") lines.push(`- not computed: ${d.reason ?? "disabled"}`);
    else if (d.status === "pending") lines.push(`- model ${d.model}: still running in the background when this report was written; the report is rewritten when it finishes`);
    else if (d.error) lines.push(`- model ${d.model}: failed after ${n(d.ms)} ms: ${d.error}`);
    else lines.push(`- model ${d.model}: ${n(d.chars)} chars in ${n(d.ms)} ms`);
    if (d.status === "background") lines.push(`- computed in the background after the jev compaction was applied; it did not delay /compact-jev`);
    if (d.status === "awaited") lines.push(`- awaited: the dry run waits for both jev and pi's default summary`);
    lines.push("");
  }
  lines.push(`## Outcome`);
  lines.push("");
  lines.push(`- ${r.outcome.applied ? "APPLIED jev compaction" : "NOT applied"}: ${r.outcome.summary}`);
  lines.push("");
  return lines.join("\n");
}

/**
 * pi-fast-jev-compaction
 *
 * Fast, verbatim, jev-guided compaction for pi. A pi version inspired by the
 * fast-jev-compaction Claude Code plugin by tamaratran
 * (https://github.com/tamaratran/fast-jev-compaction, MIT), whose core is
 * vendored in ./jev. Instead of asking an LLM to summarize old turns, every
 * tool call and result in the part of the history pi is about to discard is
 * scored by TypeSafe's jev model in one batch of fast requests; results (or
 * whole calls) it judges stale are truncated or removed, and everything else,
 * including all user and assistant text, is kept verbatim as the compaction
 * "summary". pi keeps its recent window untouched as usual.
 *
 * Commands:
 *   /compact-jev [force] [instructions]   compact via jev (falls back to pi's
 *                                          default summary when jev fails or
 *                                          frees too little; `force` applies anyway)
 *   /compact-jev-compare [instructions]   dry run: runs jev AND pi's default
 *                                          summary on the same input, writes a
 *                                          comparison bundle, leaves the session as is.
 *                                          Only registered when PI_JEV_COMPACT_DEBUG=1.
 *
 * Environment: see config.ts. TYPESAFE_API_KEY is required; PI_JEV_COMPACT_DEBUG=1
 * writes a bundle per compaction and computes pi's default summary for comparison.
 * That comparison never sits on the critical path: /compact-jev returns as soon as
 * jev has answered (about a second) and the default summary finishes in the
 * background, updating the bundle when done; only /compact-jev-compare waits for
 * it. PI_JEV_COMPACT_AUTO=1 routes pi's own /compact and auto-compaction through
 * jev as well.
 *
 * Chained compactions: the pruned messages are stored in the compaction entry's
 * `details`, so the next compaction re-evaluates them together with the new
 * messages instead of stacking summaries.
 */

import type { Message, Usage } from "@earendil-works/pi-ai";
import type {
  CompactionResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, estimateTokens, generateSummary, getLatestCompactionEntry } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { actionsFrom, applyActions, contentText, fileOperations, messagesChars, normalizeMessages, toJevMessages } from "./adapter.ts";
import { API_KEY_ENV, DEBUG_DEFAULT_ENV, type JevCompactConfig, loadConfig } from "./config.ts";
import { type Bundle, buildReport, createBundle, decisionLines, type DefaultSummaryInfo, type SizeRow, stamp, type TimingInfo } from "./debug.ts";
import { buildGoal } from "./goal.ts";
import { JevClient } from "./jev/client.ts";
import { compact as jevCompact, type CompactRun } from "./jev/compact.ts";
import type { CallDecision } from "./jev/types.ts";
import { renderSummary, renderTranscript } from "./render.ts";

export const COMMAND_NAME = "compact-jev";
export const COMPARE_COMMAND_NAME = "compact-jev-compare";
/**
 * Marker stored in compaction entries so a later compaction can re-prune them.
 * Kept at the original value on purpose: sessions compacted before the package
 * was renamed to pi-fast-jev-compaction still carry it.
 */
export const DETAILS_KIND = "pi-jev-compact";
export { API_KEY_ENV };

type NotifyLevel = "info" | "warning" | "error";
type Mode = "apply" | "dry-run";

interface PendingRequest {
  mode: Mode;
  force: boolean;
  /** When the command was issued, for the end-to-end time shown to the user. */
  startedAt: number;
}

/** A background default-summary comparison is abandoned after this long. */
const BACKGROUND_TIMEOUT_MS = 5 * 60_000;

type Settled<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ status: "fulfilled" as const, value }),
    (reason: unknown) => ({ status: "rejected" as const, reason }),
  );
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function pct(ratio: number | undefined): string {
  return ratio === undefined ? "-" : `${(ratio * 100).toFixed(1)}%`;
}

/** What a jev compaction stores in the session so the next one can re-prune it. */
export interface JevCompactionDetails {
  kind: typeof DETAILS_KIND;
  version: 1;
  messages: Message[];
  decisions: CallDecision[];
  stats: CompactRun["stats"];
  readFiles: string[];
  modifiedFiles: string[];
  /** A pi-generated summary that preceded the jev chain, carried along verbatim. */
  previousSummary?: string;
}

type BeforeCompactResult = { cancel: true } | { compaction: CompactionResult<JevCompactionDetails> } | undefined;

function say(ctx: ExtensionContext, message: string, level: NotifyLevel = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.error(`[pi-fast-jev-compaction] ${message}`);
}

function parseArgs(args: string): { force: boolean; instructions: string | undefined } {
  const trimmed = args.trim();
  const match = /^(?:--)?force(?:\s+|$)/i.exec(trimmed);
  const rest = match ? trimmed.slice(match[0].length).trim() : trimmed;
  return { force: Boolean(match), instructions: rest || undefined };
}

interface PreviousCompaction {
  /** Set when the latest compaction on the branch was ours and can be re-pruned. */
  jev?: JevCompactionDetails;
  /** File lists from the latest compaction, ours or pi's, to carry forward. */
  readFiles: string[];
  modifiedFiles: string[];
}

function previousCompaction(entries: SessionEntry[]): PreviousCompaction {
  const entry = getLatestCompactionEntry(entries);
  const details = entry?.details as Partial<JevCompactionDetails> | undefined;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  const files = { readFiles: strings(details?.readFiles), modifiedFiles: strings(details?.modifiedFiles) };
  if (details && details.kind === DETAILS_KIND && Array.isArray(details.messages)) {
    return { jev: details as JevCompactionDetails, ...files };
  }
  return files;
}

function userPrompts(entries: SessionEntry[]): string[] {
  const prompts: string[] = [];
  for (const entry of entries) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const text = contentText(entry.message.content).trim();
    if (text) prompts.push(text);
  }
  return prompts;
}

function tokensOf(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateTokens(message), 0);
}

function textTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function jevUsage(stats: CompactRun["stats"]): Usage | undefined {
  if (!stats.jevInputTokens && !stats.jevOutputTokens) return undefined;
  return {
    input: stats.jevInputTokens,
    output: stats.jevOutputTokens,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: stats.jevInputTokens + stats.jevOutputTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function cleanHeaders(headers: Record<string, unknown> | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) if (typeof value === "string") out[key] = value;
  return out;
}

interface DefaultSummaryRun {
  model: string;
  ms: number;
  text?: string;
  error?: string;
}

/**
 * pi's own summary of the same input, for side-by-side comparison. Never throws;
 * failures come back as `error` with the time spent. `signal` is the caller's: the
 * dry run passes pi's compaction signal, the background comparison its own so a
 * later compaction or prompt does not cancel it.
 */
async function defaultSummaryFor(ctx: ExtensionContext, event: SessionBeforeCompactEvent, signal: AbortSignal): Promise<DefaultSummaryRun> {
  const model = ctx.model;
  const name = model ? `${model.provider}/${model.id}` : "(none)";
  const started = Date.now();
  try {
    if (!model) throw new Error("no model selected");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error(auth.error);
    const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
    const { messagesToSummarize, turnPrefixMessages, settings, previousSummary } = event.preparation;
    const text = await generateSummary(
      [...messagesToSummarize, ...turnPrefixMessages],
      requestModel,
      settings.reserveTokens,
      auth.apiKey,
      cleanHeaders(auth.headers as Record<string, unknown> | undefined),
      signal,
      event.customInstructions,
      previousSummary,
      ctx.thinkingLevel,
      undefined,
      auth.env,
    );
    return { model: name, ms: Date.now() - started, text };
  } catch (error) {
    return { model: name, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

function debugDir(ctx: ExtensionContext, config: JevCompactConfig): string {
  return config.debugDir ?? join(ctx.cwd, ".pi", "pi-fast-jev-compaction");
}

export default function (pi: ExtensionAPI) {
  const config = loadConfig();
  let pending: PendingRequest | undefined;
  /** Default-summary comparisons still running after their compaction returned. */
  const backgroundJobs = new Set<AbortController>();

  pi.on("session_shutdown", () => {
    for (const job of backgroundJobs) job.abort();
    backgroundJobs.clear();
  });

  const status = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const bits = [config.apiKey ? "jev ✓" : `jev: no ${API_KEY_ENV}`];
    if (config.debug) bits.push("debug");
    if (config.auto) bits.push("auto");
    ctx.ui.setStatus("jev-compact", bits.join(" "));
  };

  pi.on("session_start", (_event, ctx) => status(ctx));

  const trigger = (ctx: ExtensionCommandContext, request: PendingRequest, instructions: string | undefined) => {
    if (!config.apiKey) {
      say(ctx, `/${COMMAND_NAME}: ${API_KEY_ENV} is not set`, "error");
      return;
    }
    if (!ctx.model) {
      say(ctx, `/${COMMAND_NAME}: no model selected (pi needs one to compact)`, "error");
      return;
    }
    pending = request;
    say(ctx, request.mode === "dry-run" ? "jev compare: running jev and pi's default summary (this one waits for both)…" : "jev compaction started…");
    ctx.compact({
      customInstructions: instructions,
      onComplete: (result) => {
        pending = undefined;
        const after = result.estimatedTokensAfter;
        say(
          ctx,
          `compaction done in ${seconds(Date.now() - request.startedAt)}: ${result.tokensBefore.toLocaleString("en-US")} → ~${(after ?? 0).toLocaleString("en-US")} tokens`,
        );
      },
      onError: (error) => {
        pending = undefined;
        if (request.mode === "dry-run" && /cancelled/i.test(error.message)) return; // the dry run cancels on purpose
        say(ctx, `compaction failed: ${error.message}`, "error");
      },
    });
  };

  pi.registerCommand(COMMAND_NAME, {
    description: `Compact the session via jev: verbatim history minus stale tool output (requires ${API_KEY_ENV}). Usage: /${COMMAND_NAME} [force] [instructions]`,
    handler: async (args, ctx) => {
      const { force, instructions } = parseArgs(args);
      trigger(ctx, { mode: "apply", force, startedAt: Date.now() }, instructions);
    },
  });

  // The comparison command is a development aid: it spends an LLM call on pi's default
  // summary and cancels the compaction on purpose, so it only exists in debug mode.
  if (config.debug) {
    pi.registerCommand(COMPARE_COMMAND_NAME, {
      description: "Debug: dry run comparing jev compaction with pi's default summary on the current session, without changing it",
      handler: async (args, ctx) => {
        const { instructions } = parseArgs(args);
        trigger(ctx, { mode: "dry-run", force: false, startedAt: Date.now() }, instructions);
      },
    });
  }

  pi.on("session_before_compact", async (event, ctx): Promise<BeforeCompactResult> => {
    const request = pending;
    pending = undefined;
    if (!request && !config.auto) return undefined; // pi's default compaction
    const active: PendingRequest = request ?? { mode: "apply", force: false, startedAt: Date.now() };
    if (!config.apiKey) {
      say(ctx, `jev compaction skipped: ${API_KEY_ENV} is not set; using pi's default`, "warning");
      return active.mode === "dry-run" ? { cancel: true } : undefined;
    }
    return runJev(event, ctx, active);
  });

  pi.on("session_compact", async (event, ctx) => {
    if (!config.debug) return;
    try {
      const bundle = createBundle(debugDir(ctx, config), `applied_${event.fromExtension ? "jev" : "pi-default"}_${event.reason}`);
      const entry = event.compactionEntry;
      bundle.text(
        "summary.md",
        `# Applied compaction (${event.fromExtension ? "extension" : "pi default"}, reason ${event.reason})\n\n` +
          `- entry: ${entry.id}\n- firstKeptEntryId: ${entry.firstKeptEntryId}\n- tokensBefore: ${entry.tokensBefore}\n` +
          `- summary chars: ${entry.summary.length} (~${textTokens(entry.summary)} tokens)\n\n---\n\n${entry.summary}\n`,
      );
      if (entry.details !== undefined) bundle.json("details.json", entry.details);
      say(ctx, `debug: applied compaction written to ${bundle.dir}`);
    } catch (error) {
      say(ctx, `debug bundle failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  });

  async function runJev(
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
    request: PendingRequest,
  ): Promise<BeforeCompactResult> {
    const hookStart = Date.now();
    const { preparation, branchEntries, customInstructions, reason, signal } = event;
    const wantBundle = config.debug || request.mode === "dry-run";
    // The dry run exists to compare, so it always computes pi's default summary; in debug
    // mode /compact-jev computes it too unless PI_JEV_COMPACT_DEBUG_DEFAULT=0.
    const wantDefault = request.mode === "dry-run" || (config.debug && config.debugDefaultSummary);
    const when = new Date().toISOString();
    const modelName = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "(none)";

    // 1. Candidates: previously pruned messages (if the last compaction was ours) + what pi wants gone now.
    const before = previousCompaction(branchEntries);
    const previous = before.jev;
    const previousSummaryFrom: "jev" | "pi" | "none" = previous ? "jev" : preparation.previousSummary ? "pi" : "none";
    const carriedSummary = previous ? previous.previousSummary : preparation.previousSummary;
    const newInput = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
    const newMessages = normalizeMessages(convertToLlm(newInput));
    const candidates: Message[] = [...(previous?.messages ?? []), ...newMessages];

    // Tokens the compaction replaces: the new messages plus whatever summary text is in context now.
    const replacedTokens = tokensOf(newMessages) + textTokens(preparation.previousSummary ?? "");
    const replacedChars = messagesChars(newMessages) + (preparation.previousSummary?.length ?? 0);
    const ratioFor = (summary: string) => (replacedTokens === 0 ? 0 : (replacedTokens - textTokens(summary)) / replacedTokens);

    const goal = [
      customInstructions ? `Compaction instructions from the user: ${customInstructions}` : "",
      buildGoal(userPrompts(branchEntries)),
    ]
      .filter(Boolean)
      .join("\n");

    // 2. Run jev and, when comparing, pi's default summary concurrently. Only the dry run
    //    waits for the default summary; after /compact-jev it finishes in the background.
    const client = new JevClient({ apiKey: config.apiKey, model: config.model });
    const prepMs = Date.now() - hookStart;
    const jevPromise = jevCompact(
      toJevMessages(candidates),
      client,
      {
        goal,
        keepThreshold: config.keepThreshold,
        preserveRecentMessages: config.pinRecentMessages,
        maxStateTokens: config.maxStateTokens,
        maxRequestTokens: config.maxRequestTokens,
        truncateHeadChars: config.truncateHeadChars,
      },
      signal,
    );
    const backgroundAbort = new AbortController();
    const defaultPromise = wantDefault
      ? defaultSummaryFor(ctx, event, request.mode === "dry-run" ? signal : backgroundAbort.signal)
      : undefined;
    const jevSettled = await settle(jevPromise);
    const defaultSettled = request.mode === "dry-run" && defaultPromise ? await defaultPromise : undefined;
    const applyStart = Date.now();

    const rows: SizeRow[] = [
      {
        label: "replaced context (new messages + previous summary)",
        messages: newMessages.length,
        chars: replacedChars,
        tokens: replacedTokens,
      },
    ];
    let result: BeforeCompactResult;
    let outcome = { applied: false, summary: "" };
    let jevError: string | undefined;
    let run: CompactRun | undefined;
    let summary = "";
    let details: JevCompactionDetails | undefined;

    if (jevSettled.status === "fulfilled") {
      run = jevSettled.value;
      const actions = actionsFrom(run.decisions, run.calls);
      const pruned = applyActions(candidates, actions, config.truncateHeadChars);
      // File lists cover everything being replaced (like pi's), not just the calls jev kept, and accumulate along a jev chain.
      const files = fileOperations(candidates);
      for (const f of before.readFiles) if (!files.modifiedFiles.includes(f) && !files.readFiles.includes(f)) files.readFiles.push(f);
      for (const f of before.modifiedFiles) if (!files.modifiedFiles.includes(f)) files.modifiedFiles.push(f);
      files.readFiles = files.readFiles.filter((f) => !files.modifiedFiles.includes(f)).sort();
      files.modifiedFiles.sort();
      summary = renderSummary({
        transcript: renderTranscript(pruned.messages),
        stats: {
          messages: pruned.messages.length,
          callsKept: run.stats.kept + run.stats.pinned,
          resultsTruncated: run.stats.resultsDropped,
          callsDropped: run.stats.callsDropped,
          truncateHeadChars: config.truncateHeadChars,
        },
        previousSummary: carriedSummary,
        readFiles: files.readFiles,
        modifiedFiles: files.modifiedFiles,
      });
      details = {
        kind: DETAILS_KIND,
        version: 1,
        messages: pruned.messages,
        decisions: run.decisions,
        stats: run.stats,
        readFiles: files.readFiles,
        modifiedFiles: files.modifiedFiles,
        previousSummary: carriedSummary,
      };
      rows.push({
        label: "jev verbatim summary",
        messages: pruned.messages.length,
        chars: summary.length,
        tokens: textTokens(summary),
        ratio: ratioFor(summary),
        ms: run.stats.ms,
        note: `${run.stats.callsDropped} calls removed, ${run.stats.resultsDropped} results truncated`,
      });
    } else {
      jevError = jevSettled.reason instanceof Error ? jevSettled.reason.message : String(jevSettled.reason);
    }

    const applyMs = Date.now() - applyStart;
    const jevRow = rows.find((row) => row.label === "jev verbatim summary");

    type DefaultInfo = DefaultSummaryInfo & { text?: string };
    const infoFrom = (d: DefaultSummaryRun, status: "awaited" | "background"): DefaultInfo => ({
      model: d.model,
      ms: d.ms,
      chars: d.text?.length ?? 0,
      text: d.text,
      error: d.error,
      status,
    });
    const defaultRow = (info: DefaultInfo): SizeRow | undefined =>
      info.text === undefined
        ? undefined
        : { label: "pi default summary", messages: 1, chars: info.chars, tokens: textTokens(info.text), ratio: ratioFor(info.text), ms: info.ms, note: info.model };
    let defaultInfo: DefaultInfo | undefined;
    if (defaultSettled) {
      defaultInfo = infoFrom(defaultSettled, "awaited");
      const row = defaultRow(defaultInfo);
      if (row) rows.push(row);
    } else if (defaultPromise) {
      defaultInfo = { model: modelName, ms: 0, chars: 0, status: "pending" };
    } else if (wantBundle) {
      defaultInfo = { model: modelName, ms: 0, chars: 0, status: "skipped", reason: `${DEBUG_DEFAULT_ENV}=0` };
    }

    // 3. Decide.
    if (signal.aborted) {
      outcome = { applied: false, summary: "compaction aborted" };
      result = { cancel: true };
    } else if (request.mode === "dry-run") {
      outcome = { applied: false, summary: "dry run; session left unchanged" };
      result = { cancel: true };
    } else if (jevError) {
      outcome = { applied: false, summary: `jev failed (${jevError}); pi's default compaction used` };
      result = undefined;
    } else {
      const ratio = ratioFor(summary);
      if (ratio < config.minReductionRatio && !request.force) {
        outcome = {
          applied: false,
          summary: `jev would only free ${(ratio * 100).toFixed(1)}% of the replaced context (minimum ${(config.minReductionRatio * 100).toFixed(0)}%); pi's default compaction used. Use "/${COMMAND_NAME} force" to apply anyway.`,
        };
        result = undefined;
      } else {
        outcome = {
          applied: true,
          summary: `${run!.stats.callsDropped} calls removed, ${run!.stats.resultsDropped} results truncated, ${run!.stats.kept + run!.stats.pinned} kept; frees ${(ratio * 100).toFixed(1)}% of the replaced context${request.force && ratio < config.minReductionRatio ? " (forced)" : ""}`,
        };
        result = {
          compaction: {
            summary,
            firstKeptEntryId: preparation.firstKeptEntryId,
            tokensBefore: preparation.tokensBefore,
            usage: jevUsage(run!.stats),
            details: details!,
          },
        };
      }
    }

    // 4. Debug bundle. The report is rewritten when a background default summary finishes.
    const hookMs = Date.now() - hookStart;
    const timing: TimingInfo = { prepMs, jevMs: run?.stats.ms ?? 0, jevRequests: run?.stats.requests ?? 0, applyMs, hookMs };
    let bundle: Bundle | undefined;
    const writeReport = (info: DefaultInfo | undefined) => {
      if (!bundle) return;
      const defaultSummary: DefaultSummaryInfo | undefined = info
        ? { model: info.model, ms: info.ms, chars: info.chars, error: info.error, status: info.status, reason: info.reason }
        : undefined;
      bundle.text(
        "00-report.md",
        buildReport({
          when,
          mode: request.mode,
          reason,
          force: request.force,
          sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          jevModel: config.model,
          config: {
            keepThreshold: config.keepThreshold,
            minReductionRatio: config.minReductionRatio,
            truncateHeadChars: config.truncateHeadChars,
            pinRecentMessages: config.pinRecentMessages,
            maxStateTokens: config.maxStateTokens,
            maxRequestTokens: config.maxRequestTokens,
          },
          input: {
            newMessages: preparation.messagesToSummarize.length,
            turnPrefixMessages: preparation.turnPrefixMessages.length,
            previousJevMessages: previous?.messages.length ?? 0,
            previousSummaryChars: preparation.previousSummary?.length ?? 0,
            previousSummaryFrom,
            contextTokensBefore: preparation.tokensBefore,
            customInstructions,
          },
          rows,
          jev: run
            ? { stats: run.stats, decisions: run.decisions, calls: run.calls }
            : { stats: emptyStats(), decisions: [], calls: [], error: jevError },
          defaultSummary,
          timing,
          outcome,
        }),
      );
      if (info?.text !== undefined) bundle.text("07-default-summary.md", info.text);
    };
    if (wantBundle) {
      try {
        bundle = createBundle(debugDir(ctx, config), `${request.mode}_${reason}`);
        writeReport(defaultInfo);
        bundle.json("01-input-messages.json", { previousJevMessages: previous?.messages ?? [], newMessages, previousSummary: preparation.previousSummary ?? null });
        if (run) {
          bundle.json("02-jev-state.json", run.trace.state ?? null);
          bundle.json("03-jev-requests.json", run.trace.requests);
          bundle.text("04-jev-decisions.txt", decisionLines(run.decisions, run.calls).join("\n"));
          bundle.text("05-jev-summary.md", summary);
          bundle.json("06-jev-pruned-messages.json", details?.messages ?? []);
        }
      } catch (error) {
        say(ctx, `debug bundle failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    }

    // 5. Tell the user, with where the time went.
    const level: NotifyLevel = outcome.applied || request.mode === "dry-run" ? "info" : "warning";
    const took = run
      ? `took ${seconds(hookMs)} (jev ${seconds(run.stats.ms)} in ${run.stats.requests} request${run.stats.requests === 1 ? "" : "s"})`
      : `took ${seconds(hookMs)}`;
    const sizes = rows
      .slice(1)
      .map((row) => `${row.label}: ~${row.tokens.toLocaleString("en-US")} tokens (${pct(row.ratio)} freed${row.ms !== undefined && row.label !== "jev verbatim summary" ? ` in ${seconds(row.ms)}` : ""})`)
      .join("; ");
    const inBackground = defaultPromise && !defaultSettled ? `. pi's default summary (${modelName}) is being computed in the background for comparison` : "";
    say(
      ctx,
      `jev ${request.mode === "dry-run" ? "compare" : "compaction"}: ${outcome.summary}; ${took}${sizes ? `. ${sizes}` : ""}${inBackground}${bundle ? `. Bundle: ${bundle.dir}` : ""}`,
      level,
    );

    // 6. Background comparison: pi's default summary finishes after the compaction and updates the bundle.
    if (defaultPromise && !defaultSettled) {
      backgroundJobs.add(backgroundAbort);
      const timer = setTimeout(() => backgroundAbort.abort(), BACKGROUND_TIMEOUT_MS);
      void defaultPromise.then((d) => {
        clearTimeout(timer);
        backgroundJobs.delete(backgroundAbort);
        const info = infoFrom(d, "background");
        const row = defaultRow(info);
        if (row) rows.push(row);
        try {
          writeReport(info);
        } catch (error) {
          say(ctx, `debug bundle failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
        }
        if (row === undefined) {
          say(ctx, `debug: pi default summary (${info.model}) failed after ${seconds(info.ms)}: ${info.error ?? "no text"}`, "warning");
          return;
        }
        const versus = jevRow ? ` vs jev ~${jevRow.tokens.toLocaleString("en-US")} tokens (${pct(jevRow.ratio)} freed) in ${seconds(hookMs)}` : "";
        say(
          ctx,
          `debug: pi default summary (${info.model}) finished in the background after ${seconds(info.ms)}: ~${row.tokens.toLocaleString("en-US")} tokens (${pct(row.ratio)} freed)${versus}. It did not delay the compaction${bundle ? `. Report updated: ${bundle.dir}` : ""}`,
        );
      });
    }
    return result;
  }
}

function emptyStats(): CompactRun["stats"] {
  return {
    messagesBefore: 0,
    messagesAfter: 0,
    charsBefore: 0,
    charsAfter: 0,
    calls: 0,
    kept: 0,
    resultsDropped: 0,
    callsDropped: 0,
    pinned: 0,
    stateTokens: 0,
    stateStage: "",
    requests: 0,
    ms: 0,
    jevInputTokens: 0,
    jevOutputTokens: 0,
  };
}

// re-exported for tests
export { stamp };

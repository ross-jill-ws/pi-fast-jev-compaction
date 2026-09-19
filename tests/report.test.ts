import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, type ReportInput } from "../extensions/debug.ts";

function base(overrides: Partial<ReportInput> = {}): ReportInput {
  return {
    when: "2026-09-20T00:00:00.000Z",
    mode: "apply",
    reason: "manual",
    force: false,
    jevModel: "jev-latest",
    config: {},
    input: { newMessages: 10, turnPrefixMessages: 0, previousJevMessages: 0, previousSummaryChars: 0, previousSummaryFrom: "none", contextTokensBefore: 50_000 },
    rows: [{ label: "replaced context (new messages + previous summary)", messages: 10, chars: 40_000, tokens: 10_000 }],
    timing: { prepMs: 12, jevMs: 640, jevRequests: 1, applyMs: 3, hookMs: 660 },
    outcome: { applied: true, summary: "ok" },
    ...overrides,
  };
}

test("report shows the timing breakdown and what pi actually waited for", () => {
  const report = buildReport(base());
  assert.match(report, /## Timing/);
  assert.match(report, /\| jev \(1 request\) \| 640 \|/);
  assert.match(report, /hook total \(what pi waited for\)\*\* \| \*\*660\*\*/);
});

test("report distinguishes a pending, a background and an awaited default summary", () => {
  const pending = buildReport(base({ defaultSummary: { model: "openai-codex/gpt-5.6-sol", ms: 0, chars: 0, status: "pending" } }));
  assert.match(pending, /still running in the background/);
  assert.doesNotMatch(pending, /pi default summary, openai-codex/); // no timing row until it finishes

  const background = buildReport(base({ defaultSummary: { model: "openai-codex/gpt-5.6-sol", ms: 21_193, chars: 4_733, status: "background" } }));
  assert.match(background, /\| pi default summary, openai-codex\/gpt-5\.6-sol \(background, not waited for\) \| 21,193 \|/);
  assert.match(background, /did not delay \/compact-jev/);

  const awaited = buildReport(base({ mode: "dry-run", defaultSummary: { model: "m", ms: 20_000, chars: 100, status: "awaited" } }));
  assert.match(awaited, /awaited by the dry run/);
  assert.match(awaited, /the dry run waits for both/);

  const skipped = buildReport(base({ defaultSummary: { model: "m", ms: 0, chars: 0, status: "skipped", reason: "PI_JEV_COMPACT_DEBUG_DEFAULT=0" } }));
  assert.match(skipped, /not computed: PI_JEV_COMPACT_DEBUG_DEFAULT=0/);

  const failed = buildReport(base({ defaultSummary: { model: "m", ms: 1_500, chars: 0, status: "background", error: "401 Unauthorized" } }));
  assert.match(failed, /failed after 1,500 ms: 401 Unauthorized/);
});

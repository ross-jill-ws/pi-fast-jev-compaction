# Benchmarks

All numbers below come from real pi processes driven over pi's RPC protocol, with the
extension loaded from this folder and the TypeSafe API answering for real. Nothing is
simulated. Measurements were taken on 2026-09-19 and 2026-09-20 from Sydney, Australia.

## Method

- **pi** 0.84.2 (2026-09-19 runs) and 0.85.1 (2026-09-20 runs), `pi --mode rpc --no-extensions
  --approve -e <extension> --session <copy of a session file>`. Compaction time is the interval
  between pi's `compaction_start` and `compaction_end` events, which is what a user waits for.
- **jev**: `jev-latest`, which resolved to `jev-1.13.0`, at the default keep threshold 0.5
  unless stated. State budget 25k tokens, request budget 30k tokens.
- **Default summary model**: `openai/gpt-5` for the 2026-09-19 runs, `openai-codex/gpt-5.6-sol`
  with medium thinking for the 2026-09-20 runs.
- **Sessions**:
  - *real-990*: pi-mono's own `before-compaction.jsonl` test fixture, a real 990-message
    refactoring session with 180,820 context tokens and a previous pi compaction. pi asks to
    compact 383 messages plus a 7-message split-turn prefix (172 tool calls).
  - *author-25*: the author's real pi session in which the extension was being developed, 25
    messages in one split turn, 101,686 context tokens, 14 tool calls.
  - Synthetic sessions generated to exercise split turns, images, bash executions, thinking
    blocks, chained compactions, a previous pi compaction and a text-only history.
- **Tokens** are estimates: pi's estimator for messages, `chars / 4` for summary text.
  "Replaced context" is the new candidate messages plus any previous summary text.

## Speed

### Is the jev round trip as fast as in the Claude Code plugin?

Same input (author-25), same endpoint, three alternating runs of each core:

| Core | Run 1 | Run 2 | Run 3 | Requests | Decisions |
|---|---:|---:|---:|---:|---|
| fast-jev-compaction `dist/` (Claude Code plugin) | 672 ms | 261 ms | 265 ms | 1 | 13 of 14 calls removed |
| pi-fast-jev-compaction vendored core | 639 ms | 279 ms | 320 ms | 1 | 13 of 14 calls removed |
| One tiny jev request (network floor) | 289 ms | | | 1 | |

The first run of each includes TLS warm-up. The cores are the same code and make the same
single request.

### End to end in pi

| Command | Session | Compaction time | Notes |
|---|---|---:|---|
| `/compact-jev`, debug off | author-25 | **0.62 s** | jev 0.6 s, 1 request; 101,686 → ~24,890 tokens |
| `/compact-jev`, debug on | author-25 | **0.71 s** | default summary finished 20.2 s later in the background |
| `/compact-jev`, debug off | real-990 | **1.23 s** | jev 1.2 s, 4 requests; 180,820 → ~31,351 tokens |
| `/compact-jev`, debug on | real-990 | **1.18 s** | default summary finished 37.7 s later in the background |
| `/compact-jev-compare` (waits for both by design) | real-990 | 48.8 s | jev 1.2 s + default 48.8 s |
| plain `/compact` (pi default) | real-990 | 48.8 s | gpt-5.6-sol |
| plain `/compact` (pi default) | real-990, 2026-09-19 | 15.1 s | gpt-5 |

Inside the hook, preparing candidates took 0 to 2 ms and applying decisions plus rendering
0 to 1 ms in every run. The jev round trip is the whole cost.

Before 2026-09-20 the debug switch awaited the default summary before returning jev's result,
so with debugging on `/compact-jev` took 21 to 24 s on author-25 even though jev had answered
in 0.63 to 0.67 s. That is the reason the comparison now runs in the background.

## Size and content

Reduction is relative to the replaced context. A larger jev transcript is not a defect by
itself: it is verbatim text, while the default summary is a rewrite.

| Session | Replaced context | jev transcript | jev decisions | jev time | pi default summary | default time |
|---|---:|---:|---|---:|---:|---:|
| real-990 (0.5) | 115,395 tokens, 387 msgs | 11,546 tokens, 122 msgs (**90.0%** freed) | 171 removed, 1 truncated, 0 kept | 1.18 s, 4 to 5 requests | 1,462 to 1,568 tokens (98.6 to 98.7%) | 15 s (gpt-5), 38 to 49 s (gpt-5.6-sol) |
| author-25 (0.5) | 62,746 tokens, 25 msgs | 1,850 tokens, 4 msgs (**97.1%**) | 13 removed, 1 truncated | 0.63 to 0.71 s, 1 request | 1,094 to 1,342 tokens (98.1 to 98.3%) | 20 to 24 s (gpt-5.6-sol) |
| chained: 5 previously pruned + 59 new + 13 prefix | 33,853 tokens, 72 msgs | 683 tokens, 23 msgs (**98.0%**) | 38 removed, 1 truncated of 39 | 0.95 s, 1 request | 984 tokens (97.1%) | 22.4 s (gpt-5) |
| after a previous pi compaction (summary and file lists carried) | ~44.6k tokens | ~776 tokens (98.3%) | | 0.9 s | ~596 tokens (98.7%) | 18.5 s |
| images + bash executions + thinking (0.5) | 46,518 tokens, 131 msgs | ~832 tokens (98.2%) | | 0.9 s | ~606 tokens (98.7%) | 20 s |
| tool-heavy synthetic, split turn | ~7.2k tokens | ~198 tokens (97.2%) | | 0.6 s | ~777 tokens (89.1%) | 20 s |
| 43-message split turn | ~43.9k tokens | 125 to 250 tokens (99.5%) | | 0.7 s | ~817 tokens (98.1%) | 22 s |
| text only, no tool calls | 30,942 tokens, 49 msgs | 31,174 tokens (−0.7%) → **falls back** to pi's default | no jev request | 0 s | 567 tokens (98.2%) | 24.6 s |

Rows marked `~` are read from run logs rather than preserved reports.

### Keep-threshold sweep on real-990

| Threshold | Kept | Results truncated | Calls removed | Transcript | Freed |
|---:|---:|---:|---:|---:|---:|
| 0.5 (default) | 0 | 1 | 171 | 11,546 tokens | 90.0% |
| 0.15 | 84 | 79 | 9 | 82,504 tokens | 28.5% |

On the images fixture with threshold 0 (keep everything) the transcript is 47,578 tokens for a
46,518-token input (−2.3%): kept tool results are rendered in full, images become
`[image omitted]`, and no base64 is stored.

### What jev decides

In every session tested, real or synthetic, and however the goal was phrased (original task
plus recent prompts, with or without custom instructions), jev's probabilities at threshold 0.5
were mostly 0.1 to 0.4 for "the call still matters" and under 0.2 for "the full output must
stay". In practice the transcript at 0.5 is the user and assistant text of the old history
with almost every tool call removed. That is lossless for text and frees around 90 to 98% of
the replaced context, but if you want tool output retained, lower the threshold and accept a
much smaller reduction.

jev usage for reference: real-990 sent 111k to 137k input tokens over 4 to 5 requests and got
6.7k output tokens back; author-25 sent 4.6k and got 0.5k.

## Behaviour in edge cases

| Scenario | Result |
|---|---|
| Bad `TYPESAFE_API_KEY` | jev returns 401; the user is notified and pi's default compaction runs (`fromHook=false`) |
| Key missing | `/compact-jev` refuses with an error; pi's default is untouched |
| Session too small | pi's "Nothing to compact" is surfaced through the command's error callback |
| Text-only history | No jev request; reduction below 25%, so pi's default runs; `force` applies the transcript anyway |
| `PI_JEV_COMPACT_AUTO=1` and pi's own compaction | Routed through jev (`details.kind = pi-jev-compact`) |
| Custom instructions | Appear first in jev's goal and as pi's custom instructions; recorded in the report |
| Chained jev compactions | The previously pruned messages are re-evaluated with the new ones; one transcript, not stacked summaries |
| Dry run (`/compact-jev-compare`) | Bundle written, session unchanged, pi reports the compaction as cancelled |
| Compaction aborted by the user | The hook returns `cancel` and nothing is stored |

## Reproducing

1. `export PI_JEV_COMPACT_DEBUG=1` and open a session worth compacting.
2. `/compact-jev-compare` writes a bundle with both candidates, the decisions and the timing
   table without changing the session; `/compact-jev` applies it.
3. For a threshold sweep, set `PI_JEV_COMPACT_KEEP_THRESHOLD` before starting pi and compare
   the `04-jev-decisions.txt` files.

The fixture used for real-990 is `packages/coding-agent/test/fixtures/before-compaction.jsonl`
in the pi-mono repository; its stored `cwd` must exist locally before pi will open it.

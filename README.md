# pi-fast-jev-compaction

Fast, verbatim, jev-guided compaction for [pi](https://github.com/badlogic/pi-mono).

This is a pi version inspired by **[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)**,
the Claude Code plugin by [tamaratran](https://github.com/tamaratran). The algorithm, the jev
prompts and the core implementation are theirs (MIT); this package adapts them to pi's
compaction pipeline, adds chained re-pruning, a debugging mode and benchmarks. See
[Credits](#credits).

## Why

pi's built-in `/compact` asks an LLM to rewrite old turns into a summary. That takes 15 to 50
seconds and is lossy: a file path, an exact error, a constraint the user stated once or a
command line can disappear even when it matters later.

`/compact-jev` never rewrites anything. It shows TypeSafe's **jev** model the whole
conversation and asks it, for every tool call in the part pi is about to discard, two
probability questions:

1. does knowing this call was made, with its input, still matter?
2. does its full output still need to stay verbatim?

Calls jev judges stale are removed with their output; calls whose output is stale keep their
first 300 characters plus a note; everything else, including **all user and assistant text**,
stays verbatim and in order. That pruned transcript becomes pi's compaction "summary". pi's
recent window (`compaction.keepRecentTokens`) is untouched as usual.

| | pi default `/compact` | `/compact-jev` |
|---|---|---|
| Time you wait (real 990-message session, 180k tokens) | 15 to 49 s depending on model | **1.2 s** |
| Time you wait (25-message session, 101k tokens) | 20 to 24 s | **0.6 to 0.7 s** |
| User and assistant text | Rewritten by an LLM | Verbatim |
| Tool output | Rewritten by an LLM | Kept, truncated or removed per call, as jev decides |
| Context freed (those two sessions) | 98% | 90% and 97% |

Full numbers: [references/benchmarks.md](references/benchmarks.md).

## Install

```bash
pi install npm:@rossz/pi-fast-jev-compaction
```

Or straight from GitHub, or try it without installing:

```bash
pi install git:github.com/ross-jill-ws/pi-fast-jev-compaction
pi -e npm:@rossz/pi-fast-jev-compaction
```

For local development, point pi at the checkout:

```bash
pi -e /path/to/pi-fast-jev-compaction/extensions/index.ts
# or in ~/.pi/agent/settings.json:  { "packages": ["/path/to/pi-fast-jev-compaction"] }
```

### Requirements

- pi 0.84 or newer.
- A TypeSafe API key in `TYPESAFE_API_KEY`. Without it `/compact-jev` refuses to run and pi's
  default compaction is unaffected.

```bash
export TYPESAFE_API_KEY="$(cat ~/.typesafe/<your-key-file>)"
```

## Usage

| Command | What it does |
|---|---|
| `/compact-jev [instructions]` | Compact via jev. Falls back to pi's default summary when jev fails, when the key is missing, or when the pruned transcript would free less than 25% of the replaced context. |
| `/compact-jev force [instructions]` | Same, but applies the jev result even below the 25% minimum. |
| `/compact-jev-compare [instructions]` | **Debug mode only** (`PI_JEV_COMPACT_DEBUG=1`). Dry run that runs jev *and* pi's default summary on the same input, writes a comparison bundle and leaves the session unchanged. Waits for both, so it takes as long as a default compaction. |

Instructions are passed to jev as part of its goal and to pi's summarizer as custom
instructions.

Plain `/compact` and automatic compaction keep using pi's default unless
`PI_JEV_COMPACT_AUTO=1`.

Every run tells you where the time went:

```
jev compaction: 13 calls removed, 1 results truncated, 0 kept; frees 97.1% of the replaced context;
  took 0.7 s (jev 0.7 s in 1 request). jev verbatim summary: ~1,850 tokens (97.1% freed)
compaction done in 0.7 s: 101,686 → ~24,890 tokens
```

## Configuration

Everything is an environment variable.

| Variable | Default | Meaning |
|---|---|---|
| `TYPESAFE_API_KEY` | | TypeSafe key (required) |
| `PI_JEV_COMPACT_KEEP_THRESHOLD` | `0.5` | Minimum jev probability for a call or result to stay. Lower keeps more tool output and frees less |
| `PI_JEV_COMPACT_MIN_REDUCTION` | `0.25` | Minimum reduction of the replaced context to apply the jev result; below it pi's default runs |
| `PI_JEV_COMPACT_TRUNCATE_HEAD` | `300` | Characters kept of a truncated tool result |
| `PI_JEV_COMPACT_PIN_RECENT` | `0` | Newest candidate messages never touched (pi already keeps its recent window) |
| `PI_JEV_COMPACT_AUTO` | off | Route pi's own `/compact` and automatic compaction through jev too |
| `PI_JEV_COMPACT_MODEL` | `jev-latest` | jev model |
| `PI_JEV_COMPACT_MAX_STATE_TOKENS` | `25000` | jev state budget |
| `PI_JEV_COMPACT_MAX_REQUEST_TOKENS` | `30000` | jev request budget (state plus one batch of questions) |
| `PI_JEV_COMPACT_DEBUG` | off | Debug mode: bundles, background comparison with pi's default summary, `/compact-jev-compare` |
| `PI_JEV_COMPACT_DEBUG_DEFAULT` | on | In debug mode, whether to compute pi's default summary at all; `0` writes bundles only |
| `PI_JEV_COMPACT_DEBUG_DIR` | `<cwd>/.pi/pi-fast-jev-compaction` | Where bundles go |

## Benchmarks

Measured against real pi processes (0.84.2 and 0.85.1) over its RPC protocol, with the real
TypeSafe API. Compaction time is what the user waits for, from `compaction_start` to
`compaction_end`. Method, fixtures and every table: [references/benchmarks.md](references/benchmarks.md).

### Speed

| Command | Session | Time you wait |
|---|---|---:|
| `/compact-jev` | 25 messages, 14 tool calls, 101k context tokens | **0.62 s** (jev 0.6 s, 1 request) |
| `/compact-jev` | real 990-message session, 172 tool calls, 180k context tokens | **1.23 s** (jev 1.2 s, 4 requests) |
| `/compact-jev` with debug mode on | same two sessions | 0.71 s and 1.18 s; the comparison summary finished 20 s and 38 s later in the background |
| pi default `/compact` | real 990-message session | 15.1 s with `openai/gpt-5`, 48.8 s with `openai-codex/gpt-5.6-sol` |

The jev round trip is the whole cost: preparing candidates and applying decisions took 0 to
2 ms in every run. The vendored core is as fast as the Claude Code plugin's on identical input
(0.26 to 0.67 s versus 0.28 to 0.64 s over three runs each, one request).

### Size and content

| Session | Replaced context | jev transcript | pi default summary |
|---|---:|---:|---:|
| real 990-message session | 115,395 tokens | 11,546 tokens, **90.0% freed**, 171 of 172 calls removed | 1,462 to 1,568 tokens, 98.7% |
| 25-message session | 62,746 tokens | 1,850 tokens, **97.1%**, 13 of 14 calls removed | 1,094 to 1,342 tokens, 98.3% |
| chained: previously pruned + 72 new messages | 33,853 tokens | 683 tokens, **98.0%**, 38 of 39 calls removed | 984 tokens, 97.1% |
| images, bash executions, thinking blocks | 46,518 tokens | ~832 tokens, 98.2% | ~606 tokens, 98.7% |
| text only, no tool calls | 30,942 tokens | 31,174 tokens, no reduction, **falls back** to pi's default | 567 tokens, 98.2% |

Keep-threshold sweep on the real session: at 0.5 jev keeps 0 of 172 calls and frees 90%; at
0.15 it keeps 84, truncates 79, removes 9 and frees 28.5%.

## Debug mode

`PI_JEV_COMPACT_DEBUG=1` writes a bundle per compaction under `<cwd>/.pi/pi-fast-jev-compaction/`
with the report, the exact jev state and answers, per-call decisions with both probabilities,
the transcript, and pi's default summary of the same input. The default summary is computed
**in the background** after `/compact-jev` has returned, so debugging never slows the
compaction; only `/compact-jev-compare` waits for it. Plain `/compact` results are captured
too, so the two can be compared on identical input.

Details, the bundle layout and how to read a report: [references/debug-mode.md](references/debug-mode.md).

## How it works

1. pi fires `session_before_compact` with the messages it wants gone (plus a split-turn prefix
   when the cut lands inside a turn). The extension converts them with pi's `convertToLlm`,
   replaces images with `[image omitted]` and drops thinking blocks.
2. If the previous compaction on the branch was also jev's, its stored pruned messages are
   prepended and re-evaluated, so chained compactions never stack summaries. A previous
   pi-generated summary is carried along verbatim instead.
3. jev's goal is the original task plus the last substantive prompts and any instructions. The
   state is fitted into 25k estimated tokens the way the plugin does it, and the questions go
   out in as many concurrent requests as needed.
4. Decisions are applied to pi's messages; the transcript is rendered without truncating kept
   results, with pi-style `<read-files>` / `<modified-files>` lists covering everything replaced.
5. The compaction is returned to pi, or nothing is returned and pi's default runs when jev
   failed or the reduction is below the minimum.

The full walk-through and a comparison with the Claude Code plugin:
[references/how-it-works.md](references/how-it-works.md).

## Good to know

- At the default 0.5 threshold jev dropped **almost every** old tool call in every session
  tested, real or synthetic (probabilities were mostly 0.1 to 0.4 for calls and under 0.2 for
  results). In practice the transcript is the user and assistant text of the old history. Lower
  `PI_JEV_COMPACT_KEEP_THRESHOLD` if you want tool output retained, and expect a much smaller
  reduction.
- Verbatim text is larger than an LLM summary. For text-heavy histories the 25% minimum
  correctly hands over to pi's default; `force` overrides it.
- pi wraps the transcript in its usual "compacted into the following summary" framing, so the
  model sees a transcript inside `<summary>` tags rather than real messages.
- Compaction entries are tagged `details.kind = "pi-jev-compact"`, the extension's original
  name, so sessions compacted before the rename keep re-pruning correctly.

## Development

```
extensions/index.ts     commands, session_before_compact / session_compact hooks, fallback, debug bundles
extensions/adapter.ts   pi messages <-> jev messages, normalization, applying decisions, file lists
extensions/render.ts    the verbatim transcript and summary text
extensions/goal.ts      jev's goal from the user's prompts
extensions/debug.ts     bundle writer and report
extensions/config.ts    environment variables
extensions/jev/         the fast-jev-compaction core, vendored (see Credits)
references/             how-it-works.md, debug-mode.md, benchmarks.md
tests/                  unit tests with a fake jev, no network
```

```bash
node --test tests/*.test.ts
```

Type-check against the installed pi runtime rather than a pi-mono checkout, whose `dist` may
be older than its source: map `@earendil-works/*` in `paths` to the runtime's `dist` folders.

## Credits

- **[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction)** by
  [tamaratran](https://github.com/tamaratran): the idea of verbatim, jev-guided compaction,
  the two-question formulation, the state fitting and the core implementation. `extensions/jev/`
  is that project's `src/` with small changes (abort signal, usage accounting, paired calls
  returned with the result, a pi-specific truncation note). MIT, notice reproduced in
  [LICENSE](LICENSE).
- [TypeSafe](https://typesafe.ai) for the jev model.
- [pi](https://github.com/badlogic/pi-mono) by Mario Zechner for an extension API that lets a
  compaction be replaced in a few dozen lines.

## License

MIT. See [LICENSE](LICENSE), which also carries the fast-jev-compaction notice for the
vendored code.

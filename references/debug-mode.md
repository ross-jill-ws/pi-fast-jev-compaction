# Debug mode

`PI_JEV_COMPACT_DEBUG=1` turns on everything you need to see what jev decided and how the
result compares with pi's default compaction on identical input. It is meant for development
and for tuning `PI_JEV_COMPACT_KEEP_THRESHOLD`; it costs disk space and, unless disabled, one
extra LLM call per compaction.

```bash
export TYPESAFE_API_KEY="$(cat ~/.typesafe/<your-key-file>)"
export PI_JEV_COMPACT_DEBUG=1
pi
```

The footer status shows `jev ✓ debug`.

## What debug mode adds

| | Normal | Debug |
|---|---|---|
| `/compact-jev` | Applies jev compaction, notifies with sizes and timing | Same, plus a bundle on disk and pi's default summary computed **in the background** for comparison |
| `/compact-jev-compare` | Not registered | Dry run: runs jev and pi's default summary, writes a bundle, leaves the session unchanged |
| Plain `/compact`, automatic compaction | Unchanged | An `applied_pi-default_*` bundle records what pi applied |
| Notifications | Outcome, sizes, hook time, jev time and request count | Same, plus bundle path and a second notification when the background comparison finishes |

### The background comparison

The default summary is only a reference point, so it never delays the compaction. After
`/compact-jev` the hook returns as soon as jev has answered (about a second); the default
summary keeps running with its own abort signal, so a new prompt or another compaction does
not cancel it, and it is abandoned after five minutes or when the session shuts down. When it
finishes, the bundle's report is rewritten with the comparison and a notification shows both
sizes and both times.

Only `/compact-jev-compare` waits for both, because comparing is its purpose. That command
therefore takes as long as pi's default compaction.

Set `PI_JEV_COMPACT_DEBUG_DEFAULT=0` to keep the bundles but skip the default summary
entirely. `/compact-jev-compare` ignores that switch.

## Bundle layout

Bundles are written under `<cwd>/.pi/pi-fast-jev-compaction/` (override with
`PI_JEV_COMPACT_DEBUG_DIR`). Add `.pi/` to your project's `.gitignore`.

```
.pi/pi-fast-jev-compaction/
├── 2026-09-19T20-56-07-155Z_apply_manual/         one /compact-jev
│   ├── 00-report.md
│   ├── 01-input-messages.json
│   ├── 02-jev-state.json
│   ├── 03-jev-requests.json
│   ├── 04-jev-decisions.txt
│   ├── 05-jev-summary.md
│   ├── 06-jev-pruned-messages.json
│   └── 07-default-summary.md                       appears when the comparison finishes
├── 2026-09-19T20-56-08-002Z_applied_jev_manual/   what pi actually stored for it
│   ├── summary.md
│   └── details.json
├── 2026-09-19T20-52-38-801Z_dry-run_manual/       one /compact-jev-compare
└── 2026-09-19T20-55-28-002Z_applied_pi-default_manual/   a plain /compact
    └── summary.md
```

The folder name is `<timestamp>_<mode>_<reason>`: mode is `apply`, `dry-run`, `applied_jev`
or `applied_pi-default`; reason is pi's `manual`, `threshold` or `overflow`.

| File | Content |
|---|---|
| `00-report.md` | The human-readable report described below |
| `01-input-messages.json` | `newMessages` (what pi wanted summarized, after image and thinking normalization), `previousJevMessages` (pruned messages from the previous jev compaction, re-evaluated), `previousSummary` |
| `02-jev-state.json` | The exact state jev saw: tool outputs replaced by notes, texts abridged if the 25k-token budget required it |
| `03-jev-requests.json` | Each question batch with jev's raw answers and usage |
| `04-jev-decisions.txt` | One line per tool call: id, action, both probabilities, tool, input, result size |
| `05-jev-summary.md` | Exactly what `/compact-jev` puts into the session as the compaction summary |
| `06-jev-pruned-messages.json` | The pruned messages stored in the compaction entry for later re-pruning |
| `07-default-summary.md` | pi's default summary of the same input |
| `applied_*/summary.md`, `details.json` | The compaction entry pi stored: id, first kept entry, tokens before, summary text, details |

## Reading `00-report.md`

```
# pi-fast-jev-compaction report

- when, mode (apply or dry-run, force), reason, session file
- session model; jev model
- config: the effective thresholds and budgets

## Input
- context tokens before (pi's estimate)
- new messages to compact (+ split-turn prefix count)
- previous compaction: none | pi (N chars of summary in context) | jev (N pruned messages re-evaluated)
- custom instructions, if any

## Sizes
| what | messages | chars | est. tokens | reduction of replaced context | time |
| replaced context (new messages + previous summary) | ... |
| jev verbatim summary (N calls removed, M results truncated) | ... | 90.0% | 1,198 ms |
| pi default summary (provider/model) | 1 | ... | 98.7% | 37,664 ms |

## jev
- tool calls: total; kept, results truncated, calls removed, pinned
- state: ~tokens (full | texts abridged), requests, ms
- jev usage: input / output tokens
t1    drop_call   call=0.23 result=0.15  exec_command({"cmd":"cat README.md"}) → 7,966ch
t13   drop_result call=0.54 result=0.26  apply_patch({"input":"*** Begin Patch..."}) → 100ch
t20   keep        call=0.71 result=0.63  read({"path":"src/a.ts"}) → 3,120ch

## Timing
| step | ms |
| prepare candidates (convert, normalize, goal) | 2 |
| jev (4 requests) | 1,198 |
| apply decisions + render | 0 |
| **hook total (what pi waited for)** | **1,200** |
| pi default summary, provider/model (background, not waited for) | 37,664 |

## pi default summary
- model ...: chars in ms
- computed in the background after the jev compaction was applied; it did not delay /compact-jev
  (or: awaited by the dry run | still running in the background | not computed: PI_JEV_COMPACT_DEBUG_DEFAULT=0)

## Outcome
- APPLIED jev compaction: ... | NOT applied: dry run | jev failed (...) | would only free N% (minimum 25%)
```

Notes on the columns:

- **replaced context** is what the compaction removes: the new candidate messages plus any
  previous summary text. Both percentages are relative to it, so jev and the default summary
  are directly comparable.
- **est. tokens** uses pi's estimator for messages and `chars / 4` for summary text.
- **decisions**: `call` is jev's probability that knowing the call was made still matters,
  `result` that its full output must stay verbatim. Actions are `keep`, `drop_result`
  (truncate to `PI_JEV_COMPACT_TRUNCATE_HEAD` chars) and `drop_call`.
- **hook total** is the time pi waited for the extension, i.e. what the user experiences.

## Typical uses

- **Check what was lost.** Diff `05-jev-summary.md` against `01-input-messages.json`, or read
  `04-jev-decisions.txt` for the calls that went.
- **Tune the threshold.** Run `/compact-jev-compare` on a real session, look at the probability
  columns, then set `PI_JEV_COMPACT_KEEP_THRESHOLD` and compare again. Lower thresholds keep
  more calls and free less; see [benchmarks.md](benchmarks.md) for a sweep.
- **Compare quality.** `05-jev-summary.md` and `07-default-summary.md` are the two candidates
  for the same input; `00-report.md` has their sizes and times side by side.
- **Confirm what pi applied.** The `applied_*` bundle is written from pi's `session_compact`
  event, so it is what the next turn will see.
- **Reproduce a jev decision.** `02-jev-state.json` and `03-jev-requests.json` are the exact
  payloads; they can be replayed against the API.

## Related environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PI_JEV_COMPACT_DEBUG` | off | Enable everything on this page |
| `PI_JEV_COMPACT_DEBUG_DEFAULT` | on | In debug mode, compute pi's default summary for comparison |
| `PI_JEV_COMPACT_DEBUG_DIR` | `<cwd>/.pi/pi-fast-jev-compaction` | Where bundles go |

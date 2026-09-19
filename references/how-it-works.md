# How it works

This document explains what `/compact-jev` does step by step, how the algorithm from the
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) Claude Code plugin
is mapped onto pi's compaction pipeline, and where the two differ.

## The idea

Most compaction asks an LLM to rewrite old turns into a summary. A summary is lossy: a file
path, an exact error message, a constraint the user stated once, or a command line can vanish
even when it matters ten turns later. It is also slow, typically 15 to 50 seconds.

jev compaction never rewrites text. It treats **tool calls and tool outputs** as the only
disposable material and asks TypeSafe's jev model, while showing it the whole conversation,
which of them are no longer needed. Everything else, including every user and assistant
message, stays verbatim and in order.

## The algorithm (from fast-jev-compaction)

1. **Pair calls with results.** Every tool call is matched with its tool result by id. Calls in
   the newest `preserveRecentMessages` messages are pinned and never touched (pi already keeps
   its own recent window verbatim, so this defaults to 0 here).
2. **Build jev's state.** The conversation is serialized for jev with every tool output replaced
   by a short note such as `ok, 4213 chars (omitted)`. If the state is still above
   `maxStateTokens` (25k estimated tokens), texts are abridged in stages until it fits. jev
   therefore judges the *shape* of the conversation, not the raw outputs.
3. **Ask two questions per call.** For each candidate call jev answers two `noul` probability
   questions: does knowing this call was made, with its input, still matter for the goal? Does
   its full output still need to stay verbatim? Questions are batched so that state plus
   questions stay under `maxRequestTokens`, and the batches are sent concurrently.
4. **Decide.** With `keepThreshold` (0.5 by default): both answers at or above the threshold
   keep the call and its result; call above but result below truncates the result to its first
   `truncateHeadChars` characters plus a note; call below removes the call together with its
   result.
5. **Apply.** Removed calls disappear from their assistant message; an assistant message left
   with no text and no calls disappears entirely, together with its result message. Truncated
   results keep their head plus a note telling the model it can re-run the tool.

## Mapping onto pi

pi decides *when* to compact and *what range* to compact. It fires `session_before_compact`
with a `preparation` object and lets an extension return its own compaction instead of the
built-in LLM summary. The extension does the following inside that hook:

| Step | pi input | What the extension does |
|---|---|---|
| Candidates | `preparation.messagesToSummarize` and `preparation.turnPrefixMessages` (present when the cut lands inside a turn) | Converted with pi's `convertToLlm`; images become `[image omitted]`; thinking-only assistant messages are dropped; bash executions are already plain messages |
| Chained compactions | `branchEntries`, `preparation.previousSummary` | If the latest compaction on the branch was made by this extension, its stored pruned messages are prepended to the candidates and re-evaluated with the new ones. A previous pi-generated summary is carried along verbatim instead |
| Goal for jev | user messages on the branch, `customInstructions` | The original task plus the last substantive prompts, with instructions first |
| jev | | The vendored fast-jev core, with pi's abort signal threaded through |
| Result | | The pruned messages are rendered as a transcript with kept results in full (pi's own serializer would cut them at 2000 characters), prefixed by a header and followed by `<read-files>` / `<modified-files>` lists that cover everything replaced, accumulated along a jev chain |
| Return | `{ summary, firstKeptEntryId, tokensBefore, usage, details }` | `details` holds the pruned messages, decisions, stats and file lists so the next compaction can re-prune; `usage` carries jev's token counts |
| Fallback | `undefined` | When jev fails, when the key is missing, or when the transcript would free less than `minReductionRatio` of the replaced context, the hook returns nothing and pi runs its default summary. `force` skips the reduction check |

pi then stores the compaction entry, rebuilds the context and fires `session_compact`. pi's
recent window (`compaction.keepRecentTokens`) is never part of the candidates.

### What "replaced context" means

The reduction figures compare the transcript with what the compaction removes from the
context: the new candidate messages plus the previous summary text, if any. Tokens are
estimated the way pi does for messages and as `chars / 4` for summary text.

### Framing

pi's extension API takes a summary string, so the model sees the transcript inside pi's usual
"compacted into the following summary" framing rather than as real messages. The header line
of the transcript explains that it is verbatim history with some tool output removed.

## Differences from the Claude Code plugin

| | fast-jev-compaction (Claude Code) | pi-fast-jev-compaction |
|---|---|---|
| Trigger | `turn.complete` hook requests compaction at `compactAtPercent` of context, and a `session.compact` hook replaces the summary | `/compact-jev`, or pi's own `/compact` and threshold compaction when `PI_JEV_COMPACT_AUTO=1` |
| Recent window | `preserveRecentMessages` pins the newest 6 messages | pi keeps `keepRecentTokens` verbatim itself; `PI_JEV_COMPACT_PIN_RECENT` defaults to 0 |
| Chained compactions | Each compaction sees the current messages | Pruned messages are stored in the compaction entry and re-pruned next time, so summaries do not stack |
| Previous LLM summary | n/a | Carried verbatim under its own heading |
| Fallback | Below 25% reduction, Claude Code's own summary is used | Same rule; `force` overrides it |
| Debugging | Toasts | `PI_JEV_COMPACT_DEBUG=1` bundles, background default-summary comparison, `/compact-jev-compare` (see [debug-mode.md](debug-mode.md)) |
| Configuration | Plugin `userConfig` | Environment variables |
| Vendored core changes | | Abort signal threaded to the asker, jev usage accumulated, paired calls returned with the result, pi-specific truncation note |

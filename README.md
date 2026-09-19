# pi-jev-compact

Quick session compaction for [pi](https://github.com/earendil-works/pi) via the jev (typesafe) API.
Adds a `/compact-jev` slash command.

> **Status: smoke test.** `/compact-jev` currently only checks the environment and prints
> `will compact`. The jev-backed compaction itself is not implemented yet.

## Requirements

`TYPESAFE_API_KEY` must be set in the environment, otherwise `/compact-jev` refuses to run:

```bash
export TYPESAFE_API_KEY=...
```

## Install

From this folder (local development):

```bash
pi -e /Users/rossz/workspace/ai-tools/pi/rossz-extensions/pi-jev-compact/extensions/index.ts
```

Or add it permanently to `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/Users/rossz/workspace/ai-tools/pi/rossz-extensions/pi-jev-compact/extensions/index.ts"
  ]
}
```

Once published:

```bash
pi install npm:pi-jev-compact
```

## Usage

| Command | Action |
|---------|--------|
| `/compact-jev` | Quick compact the session via the jev API |

Behaviour today:

- `TYPESAFE_API_KEY` missing: shows an error notification and does nothing.
- `TYPESAFE_API_KEY` set: shows `will compact` (as a TUI notification, or on stdout in print/JSON mode).

## Layout

```
extensions/index.ts   # registers /compact-jev
package.json          # pi package manifest ("pi.extensions")
tsconfig.json         # type-checking only (noEmit)
```

## Roadmap

- Hook `session_before_compact` (or call `ctx.compact()`) so the summary is produced by jev
  instead of the session model. See pi's `docs/compaction.md` for the extension contract
  (`preparation.messagesToSummarize`, `serializeConversation`, returning `{ compaction }`).
- Pass `/compact-jev <instructions>` through as custom compaction instructions.

## License

MIT

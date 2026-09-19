/**
 * pi-jev-compact
 *
 * Adds a `/compact-jev` slash command that will run a quick compaction of the
 * current session through the jev (typesafe) API.
 *
 * Requirements:
 *   TYPESAFE_API_KEY - must be set in the environment, otherwise the command
 *                      refuses to run.
 *
 * Status: smoke test. The command only validates the environment and prints
 * "will compact". The real jev-backed compaction is not implemented yet.
 * The plan is to hook `session_before_compact` (or call `ctx.compact()`) and
 * have jev produce the summary.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export const COMMAND_NAME = "compact-jev";
export const API_KEY_ENV = "TYPESAFE_API_KEY";

type NotifyLevel = "info" | "warning" | "error";

/** Print to the TUI when there is one, otherwise to stdout (print / RPC modes). */
function say(ctx: ExtensionCommandContext, message: string, level: NotifyLevel = "info"): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  } else {
    console.log(message);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand(COMMAND_NAME, {
    description: `Quick compact the session via the jev API (requires ${API_KEY_ENV})`,
    handler: async (_args, ctx) => {
      if (!process.env[API_KEY_ENV]) {
        say(ctx, `/${COMMAND_NAME}: ${API_KEY_ENV} is not set`, "error");
        return;
      }

      say(ctx, "will compact");
    },
  });
}

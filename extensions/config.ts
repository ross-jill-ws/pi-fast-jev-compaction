/**
 * Configuration for pi-fast-jev-compaction, read from environment variables.
 *
 *   TYPESAFE_API_KEY                   TypeSafe key (required for anything to happen)
 *   PI_JEV_COMPACT_DEBUG=1             write a debug bundle per compaction, compute pi's
 *                                      default summary for comparison, and expose
 *                                      /compact-jev-compare
 *   PI_JEV_COMPACT_DEBUG_DEFAULT=0     in debug mode, do NOT compute pi's default summary
 *                                      (default: computed; after /compact-jev it runs in the
 *                                      background so it never delays the compaction, only
 *                                      /compact-jev-compare waits for it)
 *   PI_JEV_COMPACT_AUTO=1              route pi's own /compact and auto-compaction
 *                                      through jev too (default: only /compact-jev)
 *   PI_JEV_COMPACT_DEBUG_DIR           where bundles go (default <cwd>/.pi/pi-jev-compact)
 *   PI_JEV_COMPACT_MODEL               jev model (default jev-latest)
 *   PI_JEV_COMPACT_KEEP_THRESHOLD      keep probability threshold (default 0.5)
 *   PI_JEV_COMPACT_MIN_REDUCTION       minimum token reduction to apply (default 0.25)
 *   PI_JEV_COMPACT_TRUNCATE_HEAD       chars kept of a dropped tool result (default 300)
 *   PI_JEV_COMPACT_PIN_RECENT          newest candidate messages never touched (default 0;
 *                                      pi already keeps the recent window verbatim)
 *   PI_JEV_COMPACT_MAX_STATE_TOKENS    jev state budget (default 25000)
 *   PI_JEV_COMPACT_MAX_REQUEST_TOKENS  jev request budget (default 30000)
 */

export const API_KEY_ENV = "TYPESAFE_API_KEY";
export const DEBUG_ENV = "PI_JEV_COMPACT_DEBUG";
export const DEBUG_DEFAULT_ENV = "PI_JEV_COMPACT_DEBUG_DEFAULT";
export const AUTO_ENV = "PI_JEV_COMPACT_AUTO";

export interface JevCompactConfig {
  apiKey: string | undefined;
  model: string;
  keepThreshold: number;
  minReductionRatio: number;
  truncateHeadChars: number;
  pinRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  debug: boolean;
  /** In debug mode, also compute pi's default summary of the same input for comparison. */
  debugDefaultSummary: boolean;
  auto: boolean;
  debugDir: string | undefined;
}

export const DEFAULTS = {
  model: "jev-latest",
  keepThreshold: 0.5,
  minReductionRatio: 0.25,
  truncateHeadChars: 300,
  pinRecentMessages: 0,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
} as const;

function flag(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function num(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): JevCompactConfig {
  const apiKey = env[API_KEY_ENV]?.trim();
  return {
    apiKey: apiKey ? apiKey : undefined,
    model: env.PI_JEV_COMPACT_MODEL?.trim() || DEFAULTS.model,
    keepThreshold: num(env.PI_JEV_COMPACT_KEEP_THRESHOLD, DEFAULTS.keepThreshold),
    minReductionRatio: num(env.PI_JEV_COMPACT_MIN_REDUCTION, DEFAULTS.minReductionRatio),
    truncateHeadChars: num(env.PI_JEV_COMPACT_TRUNCATE_HEAD, DEFAULTS.truncateHeadChars),
    pinRecentMessages: num(env.PI_JEV_COMPACT_PIN_RECENT, DEFAULTS.pinRecentMessages),
    maxStateTokens: num(env.PI_JEV_COMPACT_MAX_STATE_TOKENS, DEFAULTS.maxStateTokens),
    maxRequestTokens: num(env.PI_JEV_COMPACT_MAX_REQUEST_TOKENS, DEFAULTS.maxRequestTokens),
    debug: flag(env[DEBUG_ENV]),
    debugDefaultSummary: flag(env[DEBUG_DEFAULT_ENV], true),
    auto: flag(env[AUTO_ENV]),
    debugDir: env.PI_JEV_COMPACT_DEBUG_DIR?.trim() || undefined,
  };
}

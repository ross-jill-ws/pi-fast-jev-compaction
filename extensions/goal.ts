/**
 * jev's `goal`: the original task (first user prompt) plus the last few substantive
 * user prompts. Short acknowledgements like "ok" or "ls" are skipped so they do not
 * crowd out the prompt that describes the work in progress; the newest prompt is
 * always included. Pure, so it can be unit-tested outside pi.
 */

export const GOAL_MIN_PROMPT_CHARS = 40;
export const GOAL_MAX_PROMPT_CHARS = 500;

function clip(text: string): string {
  return text.length > GOAL_MAX_PROMPT_CHARS ? `${text.slice(0, GOAL_MAX_PROMPT_CHARS - 1)}…` : text;
}

export function buildGoal(prompts: readonly string[], recent = 3): string {
  const clean = prompts.map((p) => p.trim()).filter(Boolean);
  if (clean.length === 0) return "";
  const first = clean[0]!;
  const rest = clean.slice(1);
  const picked = rest.filter((p) => p.length >= GOAL_MIN_PROMPT_CHARS).slice(-recent);
  const newest = rest[rest.length - 1];
  if (newest !== undefined && !picked.includes(newest)) picked.push(newest);
  const lines = [`Original task: ${clip(first)}`];
  if (picked.length > 0) lines.push("Recent user prompts:", ...picked.map((p) => `- ${clip(p)}`));
  return lines.join("\n");
}

// Vendored from fast-jev-compaction (MIT, https://github.com/tamaratran/fast-jev-compaction), src/request.ts.
// Adapted for pi: .ts import specifiers; see compact.ts/client.ts for the pi-specific changes.

import type { JevAnswer, JevQuestions, JevResponse, JevState, JevTransport } from './types.ts';

export type { JevTransport };

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_MODEL = 'jev-latest';
const OPENROUTER_PINNED_MODEL = 'typesafe/jev-1.14';

/** Sent on every OpenRouter request. Frozen so a caller cannot clear either flag. */
export const OPENROUTER_PROVIDER = Object.freeze({
  zdr: true,
  data_collection: 'deny' as const,
});

export interface JevRequest {
  url: string;
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

/** Tokens the request envelope adds around state and questions. */
export function requestOverheadTokens(transport: JevTransport): number {
  return transport === 'openrouter' ? 40 : 20;
}

function requestModel(transport: JevTransport, model: string | undefined): string {
  if (transport !== 'openrouter') return model ?? DEFAULT_MODEL;
  if (model === undefined || model === DEFAULT_MODEL) return OPENROUTER_PINNED_MODEL;
  if (model.includes('/')) return model;
  if (model.startsWith('jev-')) return `typesafe/${model}`;
  return model;
}

/** The HTTP request for one Jev call. The transport picks the URL, model, and provider block. */
export function buildJevRequest(
  transport: JevTransport,
  params: {
    apiKey: string;
    model?: string;
  },
  state: JevState,
  questions: JevQuestions,
): JevRequest {
  const model = requestModel(transport, params.model);
  const payload =
    transport === 'openrouter'
      ? { model, provider: OPENROUTER_PROVIDER, state, questions }
      : { model, state, questions };
  return {
    url: transport === 'openrouter' ? OPENROUTER_DECISIONS_URL : SYSTEM_ONE_URL,
    method: 'POST',
    headers: {
      authorization: `Bearer ${params.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  };
}

/** Validates a Jev response body; throws on anything but an `answers` object. */
export function parseJevResponse(
  status: number,
  ok: boolean,
  text: string,
): JevResponse {
  if (!ok) {
    throw new Error(`Jev request failed (${status}): ${text.slice(0, 200)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Jev returned malformed JSON');
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('answers' in parsed) ||
    parsed.answers === null ||
    typeof parsed.answers !== 'object'
  ) {
    throw new Error('Jev response is missing answers');
  }
  return parsed as JevResponse;
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(
  answers: Record<string, JevAnswer>,
  name: string,
): number {
  const answer = answers[name];
  if (
    !answer ||
    !('noul' in answer) ||
    typeof answer.noul !== 'number' ||
    !Number.isFinite(answer.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return answer.noul;
}

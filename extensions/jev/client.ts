// Vendored from fast-jev-compaction (MIT, https://github.com/tamaratran/fast-jev-compaction), src/client.ts.
// pi changes: AbortSignal support so a cancelled compaction aborts in-flight Jev requests.

import { buildJevRequest, parseJevResponse } from './request.ts';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.ts';

export interface JevClientOptions {
  /** Defaults to `process.env.TYPESAFE_API_KEY`. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Defaults to the System One endpoint. */
  baseUrl?: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly baseUrl: string | undefined;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.TYPESAFE_API_KEY ?? '';
    this.model = options.model;
    this.baseUrl = options.baseUrl;
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    const request = buildJevRequest(
      { apiKey: this.apiKey, model: this.model, baseUrl: this.baseUrl },
      state,
      questions,
    );
    const response = await this.fetcher(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal,
    });
    return parseJevResponse(response.status, response.ok, await response.text());
  }
}

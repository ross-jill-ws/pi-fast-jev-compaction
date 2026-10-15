// Vendored from fast-jev-compaction (MIT, https://github.com/tamaratran/fast-jev-compaction), src/client.ts.
// pi changes: AbortSignal support so a cancelled compaction aborts in-flight Jev requests.

import { buildJevRequest, parseJevResponse, type JevTransport } from './request.ts';
import type { JevAsker, JevQuestions, JevResponse, JevState } from './types.ts';

export interface JevClientOptions {
  /** Key selected by `loadConfig`. This client does not read the environment. */
  apiKey?: string;
  /** Defaults to `jev-latest`. */
  model?: string;
  /** Selected by `loadConfig`. Callers that omit it stay on System One. */
  transport?: JevTransport;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/** Asks Jev over HTTP with the global `fetch` (or an injected one). */
export class JevClient implements JevAsker {
  private readonly apiKey: string;
  private readonly model: string | undefined;
  private readonly transport: JevTransport;
  private readonly fetcher: typeof fetch;

  constructor(options: JevClientOptions = {}) {
    this.apiKey = options.apiKey ?? '';
    this.model = options.model;
    this.transport = options.transport ?? 'typesafe';
    this.fetcher = options.fetch ?? fetch;
  }

  async ask(state: JevState, questions: JevQuestions, signal?: AbortSignal): Promise<JevResponse> {
    if (!this.apiKey) throw new Error(`${this.transport} API key is not configured`);
    const request = buildJevRequest(
      this.transport,
      { apiKey: this.apiKey, model: this.model },
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

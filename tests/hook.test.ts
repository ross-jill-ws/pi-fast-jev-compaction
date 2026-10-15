import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../extensions/index.ts";
import { assistant, toolResult, transcript, user } from "./helpers.ts";

const MANAGED_ENV = [
  "OPENROUTER_API_KEY",
  "TYPESAFE_API_KEY",
  "PI_JEV_COMPACT_AUTO",
  "PI_JEV_COMPACT_TIMEOUT_MS",
  "PI_JEV_COMPACT_DEBUG",
  "PI_JEV_COMPACT_DEBUG_DEFAULT",
  "PI_JEV_COMPACT_MODEL",
  "PI_JEV_COMPACT_MIN_REDUCTION",
  "PI_JEV_COMPACT_MAX_REQUEST_TOKENS",
  "PI_JEV_COMPACT_PIN_RECENT",
  "PI_JEV_COMPACT_DEBUG_DIR",
] as const;

type Notice = { message: string; level?: string };
type BeforeCompact = (event: unknown, ctx: unknown) => Promise<unknown>;
type CommandHandler = (args: string, ctx: unknown) => Promise<void> | void;

let commands = new Map<string, CommandHandler>();

function loadHook(): BeforeCompact {
  let handler: BeforeCompact | undefined;
  commands = new Map();
  const pi = {
    on(event: string, fn: BeforeCompact) {
      if (event === "session_before_compact") handler = fn;
      return () => {};
    },
    registerCommand(name: string, spec: { handler: CommandHandler }) {
      commands.set(name, spec.handler);
    },
  };
  extension(pi as unknown as ExtensionAPI);
  if (!handler) throw new Error("session_before_compact was not registered");
  return handler;
}

function event(signal: AbortSignal = new AbortController().signal, messages = transcript()) {
  return {
    type: "session_before_compact" as const,
    preparation: {
      firstKeptEntryId: "kept",
      messagesToSummarize: messages,
      turnPrefixMessages: [],
      isSplitTurn: false,
      tokensBefore: 1000,
      previousSummary: undefined,
      fileOps: { read: [], written: [] },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    },
    branchEntries: [],
    reason: "manual" as const,
    willRetry: false,
    signal,
  };
}

function ctx(notices: Notice[]) {
  return {
    hasUI: true,
    ui: {
      notify(message: string, level?: string) {
        notices.push({ message, level });
      },
      setStatus() {},
    },
    cwd: "/tmp",
    sessionManager: { getSessionFile: () => undefined },
  };
}

async function withHook(env: Record<string, string>, run: (hook: BeforeCompact, notices: Notice[]) => Promise<void>): Promise<void> {
  const savedEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
  const savedFetch = globalThis.fetch;
  for (const key of MANAGED_ENV) delete process.env[key];
  Object.assign(process.env, env);
  const notices: Notice[] = [];
  try {
    await run(loadHook(), notices);
  } finally {
    globalThis.fetch = savedFetch;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("session_before_compact", { concurrency: 1 }, () => {
  test("a missing key names both variables and does not call fetch", async () => {
    const calls: string[] = [];
    await withHook({}, async (hook, notices) => {
      globalThis.fetch = async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ answers: {} }), { status: 200 });
      };
      const result = await hook(event(), ctx(notices));
      assert.equal(result, undefined);
      assert.deepEqual(calls, []);
      assert.deepEqual(
        notices.map((notice) => notice.message),
        ["jev compaction skipped: OPENROUTER_API_KEY or TYPESAFE_API_KEY is not set; using pi's default"],
      );
    });
  });

  test("auto off and no pending request returns undefined and does not call fetch", async () => {
    const calls: string[] = [];
    await withHook({ OPENROUTER_API_KEY: "or-key", PI_JEV_COMPACT_AUTO: "0" }, async (hook) => {
      globalThis.fetch = async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ answers: {} }), { status: 200 });
      };
      const result = await hook(event(), ctx([]));
      assert.equal(result, undefined);
      assert.deepEqual(calls, []);
    });
  });

  test("auto on and no pending request posts the OpenRouter Decisions request", async () => {
    const calls: { url: string; authorization: string | null }[] = [];
    await withHook({ OPENROUTER_API_KEY: "or-key" }, async (hook) => {
      globalThis.fetch = async (input, init) => {
        const body = JSON.parse(String(init?.body)) as { questions?: Record<string, unknown> };
        calls.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
        return new Response(
          JSON.stringify({
            answers: Object.fromEntries(Object.keys(body.questions ?? {}).map((key) => [key, { noul: 0.1 }])),
          }),
          { status: 200 },
        );
      };
      await hook(event(), ctx([]));
      assert.ok(calls.length > 0);
      assert.deepEqual(
        [...new Set(calls.map((call) => call.url))],
        ["https://openrouter.ai/api/alpha/decisions"],
      );
      assert.equal(calls[0]?.authorization, "Bearer or-key");
    });
  });

  test("the hook asks twice on OpenRouter when System One still fits the transcript in one request", async () => {
    const readA = assistant("", [{ name: "read", args: { path: "a.ts" }, id: "a" }]);
    const readB = assistant("", [{ name: "read", args: { path: "b.ts" }, id: "b" }]);
    const messages = [
      user("Keep the task."),
      readA,
      toolResult("a", "read", "x".repeat(40)),
      readB,
      toolResult("b", "read", "y".repeat(40)),
    ];
    const fetches = async (env: Record<string, string>) => {
      const calls: string[] = [];
      await withHook({ ...env, PI_JEV_COMPACT_MAX_REQUEST_TOKENS: "591" }, async (hook) => {
        globalThis.fetch = async (_input, init) => {
          calls.push(String(init?.body));
          const body = JSON.parse(String(init?.body)) as { questions?: Record<string, unknown> };
          return new Response(
            JSON.stringify({
              answers: Object.fromEntries(Object.keys(body.questions ?? {}).map((key) => [key, { noul: 0.9 }])),
            }),
            { status: 200 },
          );
        };
        await hook(event(new AbortController().signal, messages), ctx([]));
      });
      return calls.length;
    };

    assert.equal(await fetches({ TYPESAFE_API_KEY: "ts-key" }), 1);
    assert.equal(await fetches({ OPENROUTER_API_KEY: "or-key" }), 2);
  });

  test("a hung Jev request times out into pi's summary", { timeout: 2_000 }, async () => {
    await withHook({ OPENROUTER_API_KEY: "or-key", PI_JEV_COMPACT_TIMEOUT_MS: "30" }, async (hook, notices) => {
      globalThis.fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      const signal = new AbortController().signal;
      const result = await hook(event(signal), ctx(notices));
      assert.equal(signal.aborted, false);
      assert.equal(result, undefined);
      assert.match(notices.map((notice) => notice.message).join("\n"), /timed out/);
      assert.match(notices.map((notice) => notice.message).join("\n"), /pi's summary is used/);
    });
  });

  test("an already-aborted compaction signal cancels", { timeout: 2_000 }, async () => {
    await withHook({ OPENROUTER_API_KEY: "or-key" }, async (hook) => {
      globalThis.fetch = (_input, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return;
          const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        });
      const controller = new AbortController();
      controller.abort();
      const result = await hook(event(controller.signal), ctx([]));
      assert.deepEqual(result, { cancel: true });
    });
  });

  test("a timed-out dry run still cancels", { timeout: 2_000 }, async () => {
    const debugDir = await mkdtemp(join(tmpdir(), "pi-jev-"));
    try {
      await withHook(
        {
          OPENROUTER_API_KEY: "or-key",
          PI_JEV_COMPACT_DEBUG: "1",
          PI_JEV_COMPACT_TIMEOUT_MS: "30",
          PI_JEV_COMPACT_DEBUG_DIR: debugDir,
        },
        async (hook) => {
          globalThis.fetch = (_input, init) =>
            new Promise((_resolve, reject) => {
              const signal = init?.signal;
              if (!signal) return;
              const abort = () => reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
              if (signal.aborted) abort();
              else signal.addEventListener("abort", abort, { once: true });
            });
          const commandCtx = {
            hasUI: true,
            ui: { notify() {}, setStatus() {} },
            model: { provider: "openrouter", id: "test" },
            compact() {},
            cwd: debugDir,
            sessionManager: { getSessionFile: () => undefined },
          };
          await commands.get("compact-jev-compare")?.("", commandCtx);
          const result = await hook(event(), ctx([]));
          assert.deepEqual(result, { cancel: true });
        },
      );
    } finally {
      await rm(debugDir, { recursive: true, force: true });
    }
  });
});

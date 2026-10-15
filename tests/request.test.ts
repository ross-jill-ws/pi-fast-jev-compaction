import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, type JevCompactConfig } from "../extensions/config.ts";
import { JevClient } from "../extensions/jev/client.ts";
import { OPENROUTER_PROVIDER } from "../extensions/jev/request.ts";
import type { JevQuestions, JevState } from "../extensions/jev/types.ts";

const state: JevState = { goal: "ship it" };
const questions: JevQuestions = { call_1: { type: "noul", instructions: "keep the call" } };

async function posted(config: JevCompactConfig): Promise<{ url: string; body: unknown; authorization: string | null }[]> {
  const calls: { url: string; body: unknown; authorization: string | null }[] = [];
  const client = new JevClient({
    apiKey: config.apiKey,
    transport: config.transport,
    model: config.model,
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response(JSON.stringify({ answers: {} }), { status: 200 });
    },
  });
  await client.ask(state, questions);
  return calls;
}

test("OpenRouter key and an unset model posts the pinned Decisions request", async () => {
  const config = loadConfig({ OPENROUTER_API_KEY: "or-key" });
  const state = { goal: "ship it" };
  const questions = { call_1: { type: "noul" as const, instructions: "keep the call" } };
  const calls: { url: string; body: unknown }[] = [];
  const client = new JevClient({
    apiKey: config.apiKey,
    transport: config.transport,
    model: config.model,
    fetch: async (input, init) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ answers: {} }), { status: 200 });
    },
  });

  await client.ask(state, questions);

  assert.equal(Object.isFrozen(OPENROUTER_PROVIDER), true);
  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://openrouter.ai/api/alpha/decisions"],
  );
  assert.deepEqual(calls[0]?.body, {
    model: "typesafe/jev-1.14",
    provider: { zdr: true, data_collection: "deny" },
    state,
    questions,
  });
});

test("JevClient does not read the environment when the key is missing", async () => {
  const previous = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "from-the-environment";
  const calls: string[] = [];
  try {
    const client = new JevClient({
      transport: "openrouter",
      fetch: async (input) => {
        calls.push(String(input));
        return new Response(JSON.stringify({ answers: {} }), { status: 200 });
      },
    });
    await assert.rejects(
      () => client.ask({ goal: "ship it" }, { call_1: { type: "noul" as const, instructions: "keep the call" } }),
      /openrouter/,
    );
    assert.deepEqual(calls, []);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = previous;
  }
});

test("a TypeSafe key and an unset model posts the System One body without a provider", async () => {
  const calls = await posted(loadConfig({ TYPESAFE_API_KEY: "ts-key" }));

  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://api.typesafe.ai/v1/systemone"],
  );
  assert.equal(calls[0]?.authorization, "Bearer ts-key");
  assert.deepEqual(calls[0]?.body, { model: "jev-latest", state, questions });
});

test("an OpenRouter key wins over a TypeSafe key and the TypeSafe host is not called", async () => {
  const calls = await posted(loadConfig({ OPENROUTER_API_KEY: "or-key", TYPESAFE_API_KEY: "ts-key" }));

  assert.deepEqual(
    calls.map((call) => call.url),
    ["https://openrouter.ai/api/alpha/decisions"],
  );
  assert.equal(calls[0]?.authorization, "Bearer or-key");
});

test("a model name containing / is sent unchanged on OpenRouter", async () => {
  const calls = await posted(
    loadConfig({ OPENROUTER_API_KEY: "or-key", PI_JEV_COMPACT_MODEL: "~typesafe/jev-latest" }),
  );

  assert.deepEqual(calls[0]?.body, {
    model: "~typesafe/jev-latest",
    provider: { zdr: true, data_collection: "deny" },
    state,
    questions,
  });
});

test("a model with no slash that is not a bare jev name is sent unchanged on both transports", async () => {
  const openRouter = await posted(loadConfig({ OPENROUTER_API_KEY: "or-key", PI_JEV_COMPACT_MODEL: "custom-judge" }));
  const typeSafe = await posted(loadConfig({ TYPESAFE_API_KEY: "ts-key", PI_JEV_COMPACT_MODEL: "custom-judge" }));

  assert.equal((openRouter[0]?.body as { model: string }).model, "custom-judge");
  assert.equal((typeSafe[0]?.body as { model: string }).model, "custom-judge");
});

test("a bare jev model name is sent to OpenRouter as typesafe/<name>", async () => {
  const calls = await posted(loadConfig({ OPENROUTER_API_KEY: "or-key", PI_JEV_COMPACT_MODEL: "jev-1.13" }));

  assert.equal((calls[0]?.body as { model: string }).model, "typesafe/jev-1.13");
});

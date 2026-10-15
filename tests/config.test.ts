import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTO_ENV, DEBUG_DEFAULT_ENV, DEBUG_ENV, loadConfig } from "../extensions/config.ts";

test("debug default-summary comparison is on by default and can be switched off", () => {
  const base = { TYPESAFE_API_KEY: "k" };
  assert.equal(loadConfig(base).debug, false);
  assert.equal(loadConfig(base).debugDefaultSummary, true);
  assert.equal(loadConfig({ ...base, [DEBUG_ENV]: "1" }).debug, true);
  assert.equal(loadConfig({ ...base, [DEBUG_ENV]: "1", [DEBUG_DEFAULT_ENV]: "0" }).debugDefaultSummary, false);
  assert.equal(loadConfig({ ...base, [DEBUG_DEFAULT_ENV]: "off" }).debugDefaultSummary, false);
  assert.equal(loadConfig({ ...base, [DEBUG_DEFAULT_ENV]: "" }).debugDefaultSummary, true);
  assert.equal(loadConfig({ ...base, [DEBUG_ENV]: "false" }).debug, false);
});

test("a blank OpenRouter key does not select a transport or hide a TypeSafe key", () => {
  assert.equal(loadConfig({ OPENROUTER_API_KEY: "  " }).apiKey, undefined);
  assert.equal(loadConfig({ OPENROUTER_API_KEY: "  " }).transport, undefined);
  assert.equal(loadConfig({ OPENROUTER_API_KEY: "  ", TYPESAFE_API_KEY: " ts-key " }).transport, "typesafe");
  assert.equal(loadConfig({ OPENROUTER_API_KEY: "  ", TYPESAFE_API_KEY: " ts-key " }).apiKey, "ts-key");
  assert.equal(loadConfig({ OPENROUTER_API_KEY: "  or-key  " }).apiKey, "or-key");
  assert.equal(loadConfig({ OPENROUTER_API_KEY: "  or-key  " }).transport, "openrouter");
});

test("auto compaction defaults on and PI_JEV_COMPACT_AUTO=0 switches it off", () => {
  const base = { OPENROUTER_API_KEY: "k" };
  assert.equal(loadConfig(base).auto, true);
  assert.equal(loadConfig({ ...base, [AUTO_ENV]: "0" }).auto, false);
  assert.equal(loadConfig({ ...base, [AUTO_ENV]: "false" }).auto, false);
  assert.equal(loadConfig({ ...base, [AUTO_ENV]: "no" }).auto, false);
  assert.equal(loadConfig({ ...base, [AUTO_ENV]: "off" }).auto, false);
  assert.equal(loadConfig({ ...base, [AUTO_ENV]: "" }).auto, true);
});

test("the Jev deadline defaults to 60000 ms", () => {
  const base = { OPENROUTER_API_KEY: "k" };
  assert.equal(loadConfig(base).timeoutMs, 60_000);
  assert.equal(loadConfig({ ...base, PI_JEV_COMPACT_TIMEOUT_MS: "1500" }).timeoutMs, 1500);
  assert.equal(loadConfig({ ...base, PI_JEV_COMPACT_TIMEOUT_MS: "" }).timeoutMs, 60_000);
});


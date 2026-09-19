import assert from "node:assert/strict";
import { test } from "node:test";
import { DEBUG_DEFAULT_ENV, DEBUG_ENV, loadConfig } from "../extensions/config.ts";

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

import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

test("schema DDL runs once per isolate, not per request", async () => {
  const calls = [];
  const DB = {
    prepare(sql) {
      return { bind() { return this; }, async run() { calls.push(sql); return {}; } };
    },
  };
  await worker.fetch(new Request("https://x/health"), { DB });
  await worker.fetch(new Request("https://x/health"), { DB });
  assert.equal(calls.filter(sql => /^\s*(CREATE|ALTER)/.test(sql)).length, 5);
});

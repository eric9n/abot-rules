import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

function fakeDb() {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = { sql, params: [] };
      return {
        bind(...p) { stmt.params = p; return this; },
        async run() { calls.push(stmt); return { meta: { changes: 0 } }; },
        async first() { calls.push(stmt); return null; },
        async all() { calls.push(stmt); return { results: [] }; },
      };
    },
  };
}

function mcp(env, body, owner = "a@x.com") {
  return worker.fetch(new Request("https://x/mcp", {
    method: "POST",
    headers: { "X-Abot-Owner-Email": owner, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), env);
}

test("schema DDL runs once per isolate, not per request", async () => {
  const env = { DB: fakeDb() };
  await worker.fetch(new Request("https://x/health"), env);
  await worker.fetch(new Request("https://x/health"), env);
  const ddl = env.DB.calls.filter(c => /^\s*(CREATE|ALTER)/.test(c.sql));
  assert.equal(ddl.length, 5);
});

test("mcp update/delete cannot touch legacy NULL-owner rules", async () => {
  const env = { DB: fakeDb() };
  for (const name of ["update_rule", "delete_rule"]) {
    const res = await mcp(env, { jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name, arguments: { id: "rule_x", enabled: false } } });
    const out = await res.json();
    assert.match(out.result.content[0].text, /not found/);
    const write = env.DB.calls.at(-1);
    assert.match(write.sql, /^(UPDATE|DELETE)/);
    assert.doesNotMatch(write.sql, /IS NULL/);
    assert.match(write.sql, /owner_email = \?$/);
    assert.equal(write.params.at(-1), "a@x.com");
  }
});

test("mcp list/get still include legacy rules", async () => {
  const env = { DB: fakeDb() };
  await mcp(env, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_rule", arguments: { id: "r" } } });
  assert.match(env.DB.calls.at(-1).sql, /owner_email IS NULL OR owner_email = \?/);
});

test("mcp tool without id is a user error, not internal", async () => {
  const env = { DB: fakeDb() };
  const out = await (await mcp(env, { jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "delete_rule", arguments: {} } })).json();
  assert.equal(out.error.code, -32602);
  assert.equal(out.error.message, "id is required");
});

test("mcp malformed JSON returns JSON-RPC parse error", async () => {
  const out = await (await mcp({ DB: fakeDb() }, "{not json")).json();
  assert.equal(out.error.code, -32700);
});

test("REST endpoints return 400 on malformed JSON", async () => {
  const env = { DB: fakeDb(), RULES_API_TOKEN: "tok" };
  const headers = { Authorization: "Bearer tok", "Content-Type": "application/json" };
  for (const [method, path] of [["POST", "/rules"], ["PUT", "/rules/rule_x"], ["POST", "/webhooks"]]) {
    const res = await worker.fetch(new Request(`https://x${path}`, { method, headers, body: "{oops" }), env);
    assert.equal(res.status, 400, `${method} ${path}`);
    const res2 = await worker.fetch(new Request(`https://x${path}`, { method, headers, body: "null" }), env);
    assert.equal(res2.status, 400, `${method} ${path} null body`);
  }
});

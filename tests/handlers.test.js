import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";

function fakeDb({ rules = [] } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = { sql, params: [] };
      return {
        bind(...p) { stmt.params = p; return this; },
        async run() { calls.push(stmt); return { meta: { changes: 0 } }; },
        async first() { calls.push(stmt); return null; },
        async all() {
          calls.push(stmt);
          return { results: /^SELECT \* FROM rules WHERE enabled/.test(sql) ? rules : [] };
        },
      };
    },
  };
}

function rule(id, owner, condition = {}) {
  return {
    id, name: id, trigger_type: "email.received", owner_email: owner,
    condition_json: JSON.stringify(condition),
    actions_json: JSON.stringify([{ type: "emit_event", event_type: "rule.hit" }]),
  };
}

async function deliver(env, body) {
  const msg = { body, acked: false, retried: false, ack() { this.acked = true; }, retry() { this.retried = true; } };
  await worker.queue({ messages: [msg] }, env);
  return msg;
}

const emitted = env => env.DB.calls.filter(c => c.sql.includes("INSERT INTO events"));

test("queue: owned rules do not fire on owner-less events; legacy rules do", async () => {
  const env = { DB: fakeDb({ rules: [rule("rule_legacy", null), rule("rule_a", "a@x.com")] }) };
  const msg = await deliver(env, { event_id: "evt_1", type: "email.received", email_id: "m1" });
  assert.equal(msg.acked, true);
  const ev = emitted(env);
  assert.equal(ev.length, 1);
  assert.match(ev[0].params[3], /^rule:rule_legacy:/);
  assert.equal(ev[0].params.at(-1), null);
});

test("queue: derived events carry the owner instead of NULL", async () => {
  const env = { DB: fakeDb({ rules: [rule("rule_legacy", null), rule("rule_a", "a@x.com"), rule("rule_b", "b@x.com")] }) };
  await deliver(env, { event_id: "evt_2", type: "email.received", email_id: "m2", owner_email: "a@x.com" });
  const ev = emitted(env);
  assert.deepEqual(ev.map(e => e.params[3].split(":")[1]).sort(), ["rule_a", "rule_legacy"]);
  for (const e of ev) assert.equal(e.params.at(-1), "a@x.com");
});

test("queue: AI condition gets data fenced as untrusted and nested JSON parses", async () => {
  let seen;
  const env = {
    DB: fakeDb({ rules: [rule("rule_ai", null, { ai_prompt: "是验证码吗" })] }),
    AI: { async run(_m, input) { seen = input; return { response: '好的 {"pass":true,"x":{"code":"1"}}' }; } },
  };
  await deliver(env, { event_id: "evt_3", type: "email.received", email_id: "m3" });
  assert.equal(seen.messages[0].role, "system");
  assert.match(seen.messages[1].content, /<data>\n[\s\S]*\n<\/data>$/);
  const ev = emitted(env);
  assert.equal(ev.length, 1);
  assert.deepEqual(JSON.parse(ev[0].params[2]).x, { code: "1" });
});

function mcp(env, body, owner = "a@x.com") {
  return worker.fetch(new Request("https://x/mcp", {
    method: "POST",
    headers: { "X-Abot-Owner-Email": owner, "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }), env);
}

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

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newId, isWebhookUrlAllowed, triggerMatches, eventTypeMatches,
  ruleAppliesToEvent, validateActions, validateRuleInput, requireAuth,
  authorizeMcp,
} from "../src/worker.js";

// ---------- SSRF allowlist ----------
test("webhook url: allows normal public https", () => {
  assert.equal(isWebhookUrlAllowed("https://example.com/hook"), true);
  assert.equal(isWebhookUrlAllowed("https://hooks.example.com:443/x"), true);
});

test("webhook url: blocks http", () => {
  assert.equal(isWebhookUrlAllowed("http://example.com/hook"), false);
});

test("webhook url: blocks loopback/private/link-local", () => {
  for (const u of [
    "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x",
    "https://172.16.0.1/x", "https://172.31.255.1/x", "https://192.168.1.1/x",
    "https://169.254.169.254/latest/meta-data", "https://0.0.0.0/x",
    "https://[::1]/x", "https://[::ffff:127.0.0.1]/x",
    "https://metadata.google.internal/x",
  ]) assert.equal(isWebhookUrlAllowed(u), false, u);
});

test("webhook url: blocks IPv4 evasions (hex/octal/decimal)", () => {
  // WHATWG URL normalizes these to 127.0.0.1
  assert.equal(new URL("https://0x7f.0.0.1/x").hostname, "127.0.0.1");
  assert.equal(isWebhookUrlAllowed("https://0x7f.0.0.1/x"), false);
  assert.equal(isWebhookUrlAllowed("https://2130706433/x"), false);
  assert.equal(isWebhookUrlAllowed("https://0177.0.0.01/x"), false);
});

test("webhook url: blocks credentials, custom ports, internal suffixes", () => {
  assert.equal(isWebhookUrlAllowed("https://user:pass@example.com/x"), false);
  assert.equal(isWebhookUrlAllowed("https://example.com:8443/x"), false);
  assert.equal(isWebhookUrlAllowed("https://svc.internal/x"), false);
  assert.equal(isWebhookUrlAllowed("https://svc.local/x"), false);
  assert.equal(isWebhookUrlAllowed("not a url"), false);
  assert.equal(isWebhookUrlAllowed(""), false);
});

// ---------- rule input validation ----------
test("validateActions: accepts good actions", () => {
  validateActions([
    { type: "webhook", url: "https://example.com/hook", secret: "s" },
    { type: "emit_event", event_type: "rule.test" },
  ]);
});

test("validateActions: rejects bad actions", () => {
  assert.throws(() => validateActions([]), /non-empty/);
  assert.throws(() => validateActions([{ type: "webhook", url: "http://evil/x" }]), /not allowed/);
  assert.throws(() => validateActions([{ type: "webhook", url: "https://169.254.169.254/x" }]), /not allowed/);
  assert.throws(() => validateActions([{ type: "exec", cmd: "id" }]), /unknown action type/);
  assert.throws(() => validateActions([{ type: "emit_event" }]), /event_type/);
});

test("validateRuleInput: requires name/trigger/actions", () => {
  assert.throws(() => validateRuleInput({}), /name/);
  assert.throws(() => validateRuleInput({ name: "r", trigger_type: "email.received" }), /actions/);
  assert.throws(() => validateRuleInput({ name: "r", trigger_type: "email received!", actions: [{ type: "emit_event", event_type: "x" }] }), /trigger_type/);
  const tt = validateRuleInput({ name: "r", trigger_type: "email.*", actions: [{ type: "emit_event", event_type: "rule.x" }] });
  assert.equal(tt, "email.*");
});

// ---------- owner scoping ----------
test("ruleAppliesToEvent: scoping matrix", () => {
  // legacy global rule fires on everything
  assert.equal(ruleAppliesToEvent({ owner_email: null }, { owner_email: "a@x" }), true);
  // events without owner (current abot-data behavior): everything fires
  assert.equal(ruleAppliesToEvent({ owner_email: "a@x" }, { owner_email: null }), true);
  assert.equal(ruleAppliesToEvent({ owner_email: "a@x" }, {}), true);
  // once events carry owner: strict match
  assert.equal(ruleAppliesToEvent({ owner_email: "a@x" }, { owner_email: "a@x" }), true);
  assert.equal(ruleAppliesToEvent({ owner_email: "a@x" }, { owner_email: "b@x" }), false);
});

// ---------- auth fail-closed ----------
test("requireAuth: fails closed without token", () => {
  const req = new Request("https://x/rules", { headers: { Authorization: "Bearer anything" } });
  assert.equal(requireAuth(req, {}), false);
});

test("requireAuth: checks bearer token", () => {
  const env = { RULES_API_TOKEN: "tok123" };
  const ok = new Request("https://x/rules", { headers: { Authorization: "Bearer tok123" } });
  const bad = new Request("https://x/rules", { headers: { Authorization: "Bearer wrong" } });
  const none = new Request("https://x/rules");
  assert.equal(requireAuth(ok, env), true);
  assert.equal(requireAuth(bad, env), false);
  assert.equal(requireAuth(none, env), false);
});

// ---------- /mcp auth (owner required, no internal token) ----------
function mcpReq(headers) {
  return new Request("https://x/mcp", { method: "POST", headers });
}

test("authorizeMcp: owner email is enough; X-Internal-Token is ignored", () => {
  const binding = authorizeMcp(mcpReq({ "X-Abot-Owner-Email": "a@x.com" }));
  assert.equal(binding.ok, true);
  assert.equal(binding.ownerEmail, "a@x.com");

  const withToken = authorizeMcp(mcpReq({
    "X-Internal-Token": "anything",
    "X-Abot-Owner-Email": "a@x.com",
  }));
  assert.equal(withToken.ok, true);
  assert.equal(withToken.ownerEmail, "a@x.com");
});

test("authorizeMcp: X-Abot-Owner-Email is required", () => {
  for (const headers of [
    {},
    { "X-Internal-Token": "sekret" },
    { "X-Abot-Owner-Email": "   " },
    { "X-Internal-Token": "sekret", "X-Abot-Owner-Email": "" },
  ]) {
    const r = authorizeMcp(mcpReq(headers));
    assert.equal(r.ok, false, JSON.stringify(headers));
    assert.equal(r.status, 401);
    assert.equal(r.error, "X-Abot-Owner-Email required");
  }
});

// ---------- matching (regression) ----------
test("triggerMatches / eventTypeMatches unchanged", () => {
  assert.equal(triggerMatches("*", "email.received"), true);
  assert.equal(triggerMatches("email.*", "email.received"), true);
  assert.equal(triggerMatches("email.*", "calendar.created"), false);
  assert.equal(eventTypeMatches("rule.x", ["rule.*"]), true);
  assert.equal(eventTypeMatches("other", ["rule.*"]), false);
});

// ---------- id generation ----------
test("newId: unique and prefixed", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newId("rule")));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^rule_[a-z0-9]+$/);
});

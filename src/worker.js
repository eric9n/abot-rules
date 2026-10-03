/**
 * abot-rules: independent rule engine worker (bypass system).
 *
 * Consumes rule-events queue, matches against user-defined rules,
 * evaluates conditions (AI), executes actions (webhook, emit_event).
 * Can be stopped anytime without affecting mail/data.
 */

const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  const rand = [...bytes].map(b => b.toString(36)).join("").replace(/[^a-z0-9]/g, "").slice(0, 10).padEnd(10, "0");
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}

async function ensureTables(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger_type TEXT NOT NULL,
    condition_json TEXT, actions_json TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rule_processed (
    event_id TEXT PRIMARY KEY,
    processed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rule_webhooks (
    id TEXT PRIMARY KEY, url TEXT NOT NULL, event_types TEXT NOT NULL, secret TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`).run();
  // owner scoping columns (idempotent)
  for (const t of ["rules", "rule_webhooks"]) {
    try {
      await env.DB.prepare(`ALTER TABLE ${t} ADD COLUMN owner_email TEXT`).run();
    } catch (e) {
      if (!/duplicate column/i.test(e.message || "")) throw e;
    }
  }
}

// Owner scoping (forward-compatible): NULL owner = legacy/global.
// Events from abot-data do not carry owner_email yet; once they do,
// non-legacy rules only fire on their owner's events.
function ruleAppliesToEvent(rule, event) {
  const ro = rule.owner_email || null;
  const eo = (event && event.owner_email) || null;
  if (!ro || !eo) return true;
  return ro === eo;
}

function triggerMatches(ruleTrigger, eventType) {
  if (ruleTrigger === "*") return true;
  if (ruleTrigger.endsWith(".*")) return eventType.startsWith(ruleTrigger.slice(0, -1));
  return ruleTrigger === eventType;
}

function eventTypeMatches(eventType, filters) {
  for (const f of filters) {
    if (f === "*") return true;
    if (f.endsWith(".*") && eventType.startsWith(f.slice(0, -1))) return true;
    if (f === eventType) return true;
  }
  return false;
}

async function signHmac(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "v1=" + [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// SSRF guard: webhooks may only target public https endpoints.
// Blocks: non-https, credentials in URL, non-443 ports, loopback/private/
// link-local/metadata hostnames. Note: DNS-rebinding (TOCTOU) between the
// hostname check and fetch is a residual risk; treat webhook URLs as
// semi-trusted and rotate signing secrets if abuse is suspected.
function isWebhookUrlAllowed(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  let h = u.hostname.toLowerCase();
  if (h.endsWith(".")) h = h.slice(0, -1);
  if (!h) return false;
  if (h === "localhost" || h === "metadata.google.internal" || h === "instance-data") return false;
  for (const sfx of [".internal", ".local", ".lan", ".localhost", ".home.arpa", ".invalid", ".example", ".test"]) {
    if (h.endsWith(sfx)) return false;
  }
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const o = v4.slice(1).map(Number);
    if (o.some(n => n > 255)) return false;
    const [a, b] = o;
    // WHATWG URL already normalizes hex/octal/decimal IPv4 forms to dotted
    // decimal, so this check covers 0x7f.0.0.1 / 2130706433 style evasions.
    if (a === 0 || a === 10 || a === 127 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254)) return false;
    return true;
  }
  if (h.includes(":")) {
    // IPv6: block loopback, unspecified, link-local, unique-local, v4-mapped.
    // Hostnames arrive bracketed (e.g. "[::1]") — strip brackets first.
    const ip6 = h.replace(/^\[|\]$/g, "");
    if (ip6 === "::1" || ip6 === "::" || ip6.startsWith("fe80:") ||
        ip6.startsWith("fc") || ip6.startsWith("fd") || ip6.startsWith("::ffff:")) return false;
    return true;
  }
  return true;
}

class UserError extends Error {
  constructor(message) { super(message); this.userFacing = true; }
}

async function sendWebhook(url, secret, payload) {
  if (!isWebhookUrlAllowed(url)) throw new UserError("webhook url not allowed");
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (secret) headers["x-abot-signature"] = await signHmac(secret, body);
  const res = await fetch(url, {
    method: "POST", headers, body,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (res.status >= 300 && res.status < 400) throw new Error("webhook redirect blocked");
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

async function fetchEntity(env, event, ownerEmail) {
  const { type } = event;
  // owner filter activates once queue events carry owner_email (abot-data);
  // today it is absent, so the filter is a no-op and behavior is unchanged.
  const of = ownerEmail ? " AND owner_email = ?" : "";
  const ob = ownerEmail ? [ownerEmail] : [];
  if (type === "email.received" || type === "email.sent") {
    return await env.DB.prepare(
      `SELECT resend_id, subject, msg_from, msg_to, date, substr(text_body,1,3000) as text FROM emails WHERE resend_id = ?${of}`
    ).bind(event.email_id, ...ob).first();
  }
  if (type.startsWith("calendar.")) {
    return await env.DB.prepare(
      `SELECT id, title, start_utc, end_utc, location FROM calendar_events WHERE id = ?${of}`
    ).bind(event.calendar_id, ...ob).first();
  }
  if (type.startsWith("contact.")) {
    return await env.DB.prepare(
      `SELECT id, name, email, org FROM contacts WHERE id = ?${of}`
    ).bind(event.contact_id, ...ob).first();
  }
  if (type.startsWith("note.")) {
    return await env.DB.prepare(
      `SELECT id, title, substr(content,1,3000) as content FROM notes WHERE id = ?${of}`
    ).bind(event.note_id, ...ob).first();
  }
  return null;
}

async function evaluateCondition(env, rule, entityData) {
  const cond = JSON.parse(rule.condition_json || "{}");
  if (!cond.ai_prompt) return { pass: true, data: {} };
  try {
    const result = await env.AI.run(AI_MODEL, {
      messages: [{
        role: "user",
        content: `${cond.ai_prompt}\n\n数据：${JSON.stringify(entityData).slice(0, 2500)}\n\n只返回 JSON。`
      }],
      max_tokens: 300,
    });
    const text = result.response || "";
    const m = text.match(/\{[^}]+\}/);
    if (!m) return { pass: false };
    const parsed = JSON.parse(m[0]);
    return { pass: parsed.pass !== false, data: parsed };
  } catch {
    return { pass: false };
  }
}

const TRIGGER_RE = /^[A-Za-z0-9.*_\-]{1,200}$/;

function validateActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 20) {
    throw new UserError("actions must be a non-empty array (max 20)");
  }
  for (const a of actions) {
    if (!a || typeof a !== "object") throw new UserError("each action must be an object");
    if (a.type === "webhook") {
      if (!a.url || typeof a.url !== "string") throw new UserError("webhook action requires url");
      if (!isWebhookUrlAllowed(a.url)) throw new UserError("webhook url not allowed");
      if (a.secret !== undefined && typeof a.secret !== "string") throw new UserError("webhook secret must be a string");
    } else if (a.type === "emit_event") {
      if (!a.event_type || typeof a.event_type !== "string" || !TRIGGER_RE.test(a.event_type)) {
        throw new UserError("emit_event action requires a valid event_type");
      }
    } else {
      throw new UserError(`unknown action type: ${a.type}`);
    }
  }
}

function validateRuleInput(body) {
  if (!body.name || typeof body.name !== "string" || body.name.length > 200) {
    throw new UserError("name is required (max 200 chars)");
  }
  const tt = body.trigger_type || (body.trigger && body.trigger.type);
  if (!tt || typeof tt !== "string" || !TRIGGER_RE.test(tt)) {
    throw new UserError("trigger_type is required (letters/digits/._*-, max 200)");
  }
  validateActions(body.actions);
  return tt;
}

async function executeActions(env, rule, event, conditionData) {
  const actions = JSON.parse(rule.actions_json || "[]");
  for (const action of actions) {
    if (action.type === "webhook") {
      await sendWebhook(action.url, action.secret, {
        rule_id: rule.id, rule_name: rule.name, event, extracted: conditionData,
      });
    } else if (action.type === "emit_event") {
      const id = newId("evt");
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO events (id, type, payload, status, dedupe_key, created_at, not_before, source, updated_at, audience, owner_email)
         VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'bot', NULL)
         ON CONFLICT(COALESCE(owner_email, ''), dedupe_key) WHERE status = 'pending' DO NOTHING`
      ).bind(id, action.event_type,
        JSON.stringify({ ...conditionData, source_rule: rule.id, source_event: event.event_id }),
        `rule:${rule.id}:${event.event_id}`, now, now, "abot-rules", now
      ).run();
      await pushWebhooks(env, action.event_type, conditionData, event.owner_email || null);
    }
  }
}

async function pushWebhooks(env, eventType, payload, eventOwner) {
  const hooks = await env.DB.prepare("SELECT url, event_types, secret, owner_email FROM rule_webhooks").all();
  for (const h of hooks.results || []) {
    try {
      if (!ruleAppliesToEvent(h, { owner_email: eventOwner || null })) continue;
      const filters = JSON.parse(h.event_types || "[]");
      if (!eventTypeMatches(eventType, filters)) continue;
      await sendWebhook(h.url, h.secret, { type: eventType, ...payload, pushed_at: new Date().toISOString() });
    } catch (e) {
      console.error(`webhook push failed: ${e.message}`);
    }
  }
}

async function processEvent(env, event) {
  const seen = await env.DB.prepare(
    "SELECT 1 FROM rule_processed WHERE event_id = ?"
  ).bind(event.event_id).first();
  if (seen) return;

  const rules = await env.DB.prepare(
    "SELECT * FROM rules WHERE enabled = 1"
  ).all();

  const entityData = await fetchEntity(env, event, event.owner_email || null);

  for (const rule of rules.results || []) {
    if (!triggerMatches(rule.trigger_type, event.type)) continue;
    if (!ruleAppliesToEvent(rule, event)) continue;
    try {
      const { pass, data } = await evaluateCondition(env, rule, entityData);
      if (pass) await executeActions(env, rule, event, data);
    } catch (e) {
      console.error(`rule ${rule.id} failed: ${e.message}`);
    }
  }

  await env.DB.prepare(
    "INSERT OR IGNORE INTO rule_processed (event_id) VALUES (?)"
  ).bind(event.event_id).run();
}

function requireAuth(request, env) {
  const token = env.RULES_API_TOKEN;
  // fail closed: no token configured => deny everything (never fail open)
  if (!token) return false;
  const got = request.headers.get("Authorization") || "";
  return got === `Bearer ${token}`;
}

// /mcp auth for two callers:
// - Gateway via Service Bindings (env.BACKEND_*.fetch) sends no
//   X-Internal-Token. Absence is trusted.
// - Direct custom-domain calls still send X-Internal-Token. A present token
//   must match INTERNAL_TOKEN; a mismatch or an unset secret fails closed.
// X-Abot-Owner-Email stays mandatory — the gateway always sets it, and
// tokenless binding calls must not create unscoped rules.
function authorizeMcp(request, env) {
  const presented = request.headers.get("X-Internal-Token");
  if (presented) {
    if (!env.INTERNAL_TOKEN || presented !== env.INTERNAL_TOKEN) {
      return { ok: false, status: 401, error: "unauthorized" };
    }
  }
  const ownerEmail = request.headers.get("X-Abot-Owner-Email");
  if (!ownerEmail || !ownerEmail.trim()) {
    return { ok: false, status: 401, error: "X-Abot-Owner-Email required" };
  }
  return { ok: true, ownerEmail };
}

async function handleRulesAPI(request, env, url) {
  if (!requireAuth(request, env)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const path = url.pathname;

  if (path === "/rules" && request.method === "POST") {
    const body = await request.json();
    let triggerType;
    try {
      triggerType = validateRuleInput(body);
    } catch (e) {
      return Response.json({ ok: false, error: e.message }, { status: 400 });
    }
    const id = newId("rule");
    const owner = request.headers.get("X-Abot-Owner-Email") || body.owner_email || null;
    await env.DB.prepare(
      "INSERT INTO rules (id, name, trigger_type, condition_json, actions_json, enabled, owner_email) VALUES (?,?,?,?,?,?,?)"
    ).bind(id, body.name, triggerType,
      JSON.stringify(body.condition || {}), JSON.stringify(body.actions || []),
      body.enabled === false ? 0 : 1, owner).run();
    return Response.json({ ok: true, id });
  }

  if (path === "/rules" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM rules ORDER BY created_at DESC").all();
    return Response.json({ ok: true, rules: rows.results });
  }

  const m = path.match(/^\/rules\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (request.method === "GET") {
      const row = await env.DB.prepare("SELECT * FROM rules WHERE id = ?").bind(id).first();
      return row ? Response.json({ ok: true, rule: row }) : Response.json({ ok: false }, { status: 404 });
    }
    if (request.method === "PUT") {
      const body = await request.json();
      const sets = [], params = [];
      try {
        if (body.name !== undefined) {
          if (typeof body.name !== "string" || !body.name || body.name.length > 200) throw new UserError("name invalid");
          sets.push("name=?"); params.push(body.name);
        }
        if (body.trigger_type !== undefined) {
          if (typeof body.trigger_type !== "string" || !TRIGGER_RE.test(body.trigger_type)) throw new UserError("trigger_type invalid");
          sets.push("trigger_type=?"); params.push(body.trigger_type);
        }
        if (body.condition !== undefined) { sets.push("condition_json=?"); params.push(JSON.stringify(body.condition)); }
        if (body.actions !== undefined) {
          validateActions(body.actions);
          sets.push("actions_json=?"); params.push(JSON.stringify(body.actions));
        }
        if (body.enabled !== undefined) { sets.push("enabled=?"); params.push(body.enabled ? 1 : 0); }
      } catch (e) {
        return Response.json({ ok: false, error: e.message }, { status: 400 });
      }
      if (sets.length === 0) return Response.json({ ok: false, error: "nothing to update" }, { status: 400 });
      sets.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      params.push(id);
      await env.DB.prepare(`UPDATE rules SET ${sets.join(",")} WHERE id=?`).bind(...params).run();
      return Response.json({ ok: true });
    }
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(id).run();
      return Response.json({ ok: true });
    }
  }
  return Response.json({ ok: false }, { status: 404 });
}

const MCP_TOOLS = [
  {
    name: "create_rule",
    description: "创建规则：trigger（事件类型）+ condition（AI prompt）+ actions（webhook/发事件）",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        trigger_type: { type: "string", description: "如 email.received，支持 email.* 通配" },
        condition: { type: "object", description: "{ai_prompt: '...'}，可空" },
        actions: { type: "array", items: { type: "object" } },
      },
      required: ["name", "trigger_type", "actions"],
    },
  },
  {
    name: "list_rules",
    description: "列出所有规则",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_rule",
    description: "查一条规则",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "update_rule",
    description: "更新规则",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" }, name: { type: "string" },
        trigger_type: { type: "string" }, condition: { type: "object" },
        actions: { type: "array" }, enabled: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_rule",
    description: "删除规则",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

// ownerEmail comes from the gateway's X-Abot-Owner-Email header (always set
// on proxied calls). Rules are scoped to their creator; legacy NULL-owner
// rules stay visible to everyone until abot-data starts sending owner_email
// on queue events, at which point firing is owner-scoped too.
async function callMcpTool(name, args, env, ownerEmail) {
  await ensureTables(env);
  const owner = ownerEmail || null;
  const scope = owner ? " AND (owner_email IS NULL OR owner_email = ?)" : "";
  const scopeParams = owner ? [owner] : [];
  if (name === "create_rule") {
    const triggerType = validateRuleInput(args);
    const id = newId("rule");
    await env.DB.prepare(
      "INSERT INTO rules (id, name, trigger_type, condition_json, actions_json, enabled, owner_email) VALUES (?,?,?,?,?,?,?)"
    ).bind(id, args.name, triggerType, JSON.stringify(args.condition || {}),
      JSON.stringify(args.actions || []), 1, owner).run();
    return { id };
  }
  if (name === "list_rules") {
    const rows = await env.DB.prepare(
      `SELECT * FROM rules WHERE 1=1${scope} ORDER BY created_at DESC`
    ).bind(...scopeParams).all();
    return { rules: rows.results };
  }
  if (name === "get_rule") {
    const row = await env.DB.prepare(
      `SELECT * FROM rules WHERE id = ?${scope}`
    ).bind(args.id, ...scopeParams).first();
    return row ? { rule: row } : { error: "not found" };
  }
  if (name === "update_rule") {
    const sets = [], params = [];
    if (args.name !== undefined) {
      if (typeof args.name !== "string" || !args.name || args.name.length > 200) throw new UserError("name invalid");
      sets.push("name=?"); params.push(args.name);
    }
    if (args.trigger_type !== undefined) {
      if (typeof args.trigger_type !== "string" || !TRIGGER_RE.test(args.trigger_type)) throw new UserError("trigger_type invalid");
      sets.push("trigger_type=?"); params.push(args.trigger_type);
    }
    if (args.condition !== undefined) { sets.push("condition_json=?"); params.push(JSON.stringify(args.condition)); }
    if (args.actions !== undefined) {
      validateActions(args.actions);
      sets.push("actions_json=?"); params.push(JSON.stringify(args.actions));
    }
    if (args.enabled !== undefined) { sets.push("enabled=?"); params.push(args.enabled ? 1 : 0); }
    if (sets.length === 0) return { ok: false, error: "nothing to update" };
    sets.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    params.push(args.id, ...scopeParams);
    const r = await env.DB.prepare(`UPDATE rules SET ${sets.join(",")} WHERE id=?${scope}`).bind(...params).run();
    if (!r.meta || r.meta.changes === 0) return { ok: false, error: "not found" };
    return { ok: true };
  }
  if (name === "delete_rule") {
    const r = await env.DB.prepare(`DELETE FROM rules WHERE id = ?${scope}`).bind(args.id, ...scopeParams).run();
    if (!r.meta || r.meta.changes === 0) return { ok: false, error: "not found" };
    return { ok: true };
  }
  throw new Error(`unknown tool: ${name}`);
}

export {
  newId, isWebhookUrlAllowed, triggerMatches, eventTypeMatches,
  ruleAppliesToEvent, validateActions, validateRuleInput, requireAuth,
  authorizeMcp,
};

export default {
  async queue(batch, env) {
    await ensureTables(env);
    for (const msg of batch.messages) {
      try {
        await processEvent(env, msg.body);
        msg.ack();
      } catch (e) {
        console.error(`event ${msg.body.event_id} failed: ${e.message}`);
        msg.retry();
      }
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    await ensureTables(env);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "abot-rules" });
    }
    // MCP endpoint: binding calls (no token) or custom-domain calls (token).
    if (url.pathname === "/mcp" && request.method === "POST") {
      const auth = authorizeMcp(request, env);
      if (!auth.ok) {
        return Response.json({ error: auth.error }, { status: auth.status });
      }
      const message = await request.json();
      const id = message.id ?? null;
      try {
        if (message.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id,
            result: { protocolVersion: "2025-06-18", capabilities: { tools: {} },
              serverInfo: { name: "abot-rules-mcp", version: "1.0.0" } } });
        }
        if (message.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } });
        }
        if (message.method === "tools/call") {
          const { name, arguments: args } = message.params || {};
          try {
            const result = await callMcpTool(name, args || {}, env, auth.ownerEmail);
            return Response.json({ jsonrpc: "2.0", id,
              result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
          } catch (e) {
            if (e && e.userFacing) {
              return Response.json({ jsonrpc: "2.0", id, error: { code: -32602, message: e.message } });
            }
            console.error(`tools/call ${name} failed: ${e && e.stack || e}`);
            return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal error" } });
          }
        }
        return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      } catch (e) {
        console.error(`mcp failed: ${e && e.stack || e}`);
        return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal error" } });
      }
    }
    if (url.pathname.startsWith("/rules")) {
      return handleRulesAPI(request, env, url);
    }
    if (url.pathname === "/webhooks" && request.method === "POST") {
      if (!requireAuth(request, env)) return Response.json({ ok: false }, { status: 401 });
      const body = await request.json();
      if (!body.url || !isWebhookUrlAllowed(body.url)) {
        return Response.json({ ok: false, error: "url not allowed" }, { status: 400 });
      }
      if (body.event_types !== undefined &&
          (!Array.isArray(body.event_types) || body.event_types.some(t => typeof t !== "string" || !TRIGGER_RE.test(t)))) {
        return Response.json({ ok: false, error: "event_types invalid" }, { status: 400 });
      }
      const id = newId("rwh");
      const owner = request.headers.get("X-Abot-Owner-Email") || body.owner_email || null;
      await env.DB.prepare(
        "INSERT INTO rule_webhooks (id, url, event_types, secret, owner_email) VALUES (?,?,?,?,?)"
      ).bind(id, body.url, JSON.stringify(body.event_types || ["rule.*"]), body.secret || null, owner).run();
      return Response.json({ ok: true, id });
    }
    if (url.pathname === "/webhooks" && request.method === "GET") {
      if (!requireAuth(request, env)) return Response.json({ ok: false }, { status: 401 });
      const rows = await env.DB.prepare("SELECT id, url, event_types, created_at, owner_email FROM rule_webhooks").all();
      return Response.json({ ok: true, webhooks: rows.results });
    }
    return Response.json({ ok: false }, { status: 404 });
  },
};

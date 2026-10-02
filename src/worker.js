/**
 * abot-rules: independent rule engine worker (bypass system).
 *
 * Consumes rule-events queue, matches against user-defined rules,
 * evaluates conditions (AI), executes actions (webhook, emit_event).
 * Can be stopped anytime without affecting mail/data.
 */

const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
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

async function sendWebhook(url, secret, payload) {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  if (secret) headers["x-abot-signature"] = await signHmac(secret, body);
  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

async function fetchEntity(env, event) {
  const { type } = event;
  if (type === "email.received" || type === "email.sent") {
    return await env.DB.prepare(
      "SELECT resend_id, subject, msg_from, msg_to, date, substr(text_body,1,3000) as text FROM emails WHERE resend_id = ?"
    ).bind(event.email_id).first();
  }
  if (type.startsWith("calendar.")) {
    return await env.DB.prepare(
      "SELECT id, title, start_utc, end_utc, location FROM calendar_events WHERE id = ?"
    ).bind(event.calendar_id).first();
  }
  if (type.startsWith("contact.")) {
    return await env.DB.prepare(
      "SELECT id, name, email, org FROM contacts WHERE id = ?"
    ).bind(event.contact_id).first();
  }
  if (type.startsWith("note.")) {
    return await env.DB.prepare(
      "SELECT id, title, substr(content,1,3000) as content FROM notes WHERE id = ?"
    ).bind(event.note_id).first();
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
      await pushWebhooks(env, action.event_type, conditionData);
    }
  }
}

async function pushWebhooks(env, eventType, payload) {
  const hooks = await env.DB.prepare("SELECT url, event_types, secret FROM rule_webhooks").all();
  for (const h of hooks.results || []) {
    try {
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

  const entityData = await fetchEntity(env, event);

  for (const rule of rules.results || []) {
    if (!triggerMatches(rule.trigger_type, event.type)) continue;
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
  if (!token) return true;
  return request.headers.get("Authorization") === `Bearer ${token}`;
}

async function handleRulesAPI(request, env, url) {
  if (!requireAuth(request, env)) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const path = url.pathname;

  if (path === "/rules" && request.method === "POST") {
    const body = await request.json();
    const id = newId("rule");
    await env.DB.prepare(
      "INSERT INTO rules (id, name, trigger_type, condition_json, actions_json, enabled) VALUES (?,?,?,?,?,?)"
    ).bind(id, body.name, body.trigger_type || (body.trigger && body.trigger.type),
      JSON.stringify(body.condition || {}), JSON.stringify(body.actions || []),
      body.enabled === false ? 0 : 1).run();
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
      await env.DB.prepare(
        "UPDATE rules SET name=?, trigger_type=?, condition_json=?, actions_json=?, enabled=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
      ).bind(body.name, body.trigger_type, JSON.stringify(body.condition || {}),
        JSON.stringify(body.actions || []), body.enabled === false ? 0 : 1, id).run();
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

async function callMcpTool(name, args, env) {
  await ensureTables(env);
  if (name === "create_rule") {
    const id = newId("rule");
    await env.DB.prepare(
      "INSERT INTO rules (id, name, trigger_type, condition_json, actions_json, enabled) VALUES (?,?,?,?,?,?)"
    ).bind(id, args.name, args.trigger_type, JSON.stringify(args.condition || {}),
      JSON.stringify(args.actions || []), 1).run();
    return { id };
  }
  if (name === "list_rules") {
    const rows = await env.DB.prepare("SELECT * FROM rules ORDER BY created_at DESC").all();
    return { rules: rows.results };
  }
  if (name === "get_rule") {
    const row = await env.DB.prepare("SELECT * FROM rules WHERE id = ?").bind(args.id).first();
    return row ? { rule: row } : { error: "not found" };
  }
  if (name === "update_rule") {
    const sets = [], params = [];
    if (args.name !== undefined) { sets.push("name=?"); params.push(args.name); }
    if (args.trigger_type !== undefined) { sets.push("trigger_type=?"); params.push(args.trigger_type); }
    if (args.condition !== undefined) { sets.push("condition_json=?"); params.push(JSON.stringify(args.condition)); }
    if (args.actions !== undefined) { sets.push("actions_json=?"); params.push(JSON.stringify(args.actions)); }
    if (args.enabled !== undefined) { sets.push("enabled=?"); params.push(args.enabled ? 1 : 0); }
    if (sets.length === 0) return { ok: false, error: "nothing to update" };
    sets.push("updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')");
    params.push(args.id);
    await env.DB.prepare(`UPDATE rules SET ${sets.join(",")} WHERE id=?`).bind(...params).run();
    return { ok: true };
  }
  if (name === "delete_rule") {
    await env.DB.prepare("DELETE FROM rules WHERE id = ?").bind(args.id).run();
    return { ok: true };
  }
  throw new Error(`unknown tool: ${name}`);
}

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
    // MCP endpoint（内部鉴权：只接受网关的 X-Internal-Token）
    if (url.pathname === "/mcp" && request.method === "POST") {
      const it = request.headers.get("X-Internal-Token") || "";
      if (!env.INTERNAL_TOKEN || it !== env.INTERNAL_TOKEN) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
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
          const result = await callMcpTool(name, args || {}, env);
          return Response.json({ jsonrpc: "2.0", id,
            result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
        }
        return Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      } catch (e) {
        return Response.json({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
      }
    }
    if (url.pathname.startsWith("/rules")) {
      return handleRulesAPI(request, env, url);
    }
    if (url.pathname === "/webhooks" && request.method === "POST") {
      if (!requireAuth(request, env)) return Response.json({ ok: false }, { status: 401 });
      const body = await request.json();
      const id = newId("rwh");
      await env.DB.prepare(
        "INSERT INTO rule_webhooks (id, url, event_types, secret) VALUES (?,?,?,?)"
      ).bind(id, body.url, JSON.stringify(body.event_types || ["rule.*"]), body.secret || null).run();
      return Response.json({ ok: true, id });
    }
    if (url.pathname === "/webhooks" && request.method === "GET") {
      const rows = await env.DB.prepare("SELECT id, url, event_types, created_at FROM rule_webhooks").all();
      return Response.json({ ok: true, webhooks: rows.results });
    }
    return Response.json({ ok: false }, { status: 404 });
  },
};

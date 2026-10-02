/**
 * abot-rules: independent rule layer worker.
 * Subscribes to the shared event bus (D1 events table), runs AI classification,
 * emits derived events, and pushes via webhooks. Can be stopped anytime.
 */

const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";
const POLL_LIMIT = 20;

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

async function ensureTables(env) {
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS rule_cursor (id TEXT PRIMARY KEY, last_at TEXT)"
  ).run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS rule_webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      event_types TEXT NOT NULL,
      secret TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`
  ).run();
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
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return "v1=" + [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function pushWebhooks(env, eventType, payload) {
  const hooks = await env.DB.prepare(
    "SELECT url, event_types, secret FROM rule_webhooks"
  ).all();
  const body = JSON.stringify({ type: eventType, ...payload, pushed_at: new Date().toISOString() });
  for (const h of hooks.results || []) {
    try {
      const filters = JSON.parse(h.event_types || "[]");
      if (!eventTypeMatches(eventType, filters)) continue;
      const headers = { "Content-Type": "application/json" };
      if (h.secret) headers["x-abot-signature"] = await signHmac(h.secret, body);
      await fetch(h.url, { method: "POST", headers, body });
    } catch (e) {
      console.error(`webhook push failed: ${h.url} - ${e.message}`);
    }
  }
}

async function classifyEmail(env, { subject, from, textSnippet }) {
  const prompt = `Classify this email. Reply with ONLY a JSON object.
Email subject: ${subject || "(none)"}
From: ${from || "(unknown)"}
Snippet: ${(textSnippet || "").slice(0, 500)}

Categories:
- "verification_code": contains a login/verification/OTP code
- "calendar_invite": meeting invitation, appointment, or event with date/time
- "other": anything else

If verification_code, include the code. If calendar_invite, include title and datetime.
JSON format: {"category":"...","code":"...","title":"...","datetime":"..."}`;

  try {
    const result = await env.AI.run(AI_MODEL, {
      messages: [{ role: "user", content: prompt }],
      max_tokens: 200,
    });
    const text = result.response || "";
    const match = text.match(/\{[^}]+\}/);
    if (!match) return { category: "other" };
    return JSON.parse(match[0]);
  } catch {
    return { category: "other" };
  }
}

async function emitRuleEvent(env, type, payload, dedupeKey) {
  const id = newId("evt");
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO events (id, type, payload, status, dedupe_key, created_at, not_before, source, updated_at, audience, owner_email)
     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, 'bot', NULL)
     ON CONFLICT(COALESCE(owner_email, ''), dedupe_key) WHERE status = 'pending' DO NOTHING`
  ).bind(id, type, JSON.stringify(payload), dedupeKey, now, now, "abot-rules", now).run();
  // Push via webhooks
  await pushWebhooks(env, type, payload);
  return id;
}

async function processEmail(env, email) {
  const classification = await classifyEmail(env, {
    subject: email.subject,
    from: email.msg_from,
    textSnippet: email.snippet,
  });
  
  if (classification.category === "verification_code" && classification.code) {
    await emitRuleEvent(env, "rule.verification_code", {
      code: classification.code,
      from: email.msg_from,
      email_id: email.resend_id,
      received_at: email.date,
    }, `rule.vcode:${email.resend_id}`);
  } else if (classification.category === "calendar_invite") {
    await emitRuleEvent(env, "rule.calendar_suggestion", {
      title: classification.title,
      datetime: classification.datetime,
      from: email.msg_from,
      email_id: email.resend_id,
    }, `rule.cal:${email.resend_id}`);
  }
}

export default {
  async scheduled(event, env, ctx) {
    await ensureTables(env);
    const cursor = await env.DB.prepare(
      "SELECT last_at FROM rule_cursor WHERE id = 'main'"
    ).first();
    const since = cursor?.last_at || "2026-01-01T00:00:00.000Z";
    
    const emails = await env.DB.prepare(
      `SELECT resend_id, subject, msg_from, date, substr(text_body, 1, 2000) as snippet, created_at
       FROM emails WHERE created_at > ?
       ORDER BY created_at ASC LIMIT ?`
    ).bind(since, POLL_LIMIT).all();
    
    let lastAt = since;
    for (const email of emails.results || []) {
      try {
        await processEmail(env, email);
        lastAt = email.created_at;
      } catch (err) {
        console.error(`Failed to process ${email.resend_id}: ${err.message}`);
      }
    }
    
    if (lastAt !== since) {
      await env.DB.prepare(
        "INSERT OR REPLACE INTO rule_cursor (id, last_at) VALUES ('main', ?)"
      ).bind(lastAt).run();
    }
  },
  
  async fetch(request, env) {
    const url = new URL(request.url);
    await ensureTables(env);
    
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "abot-rules" });
    }
    
    // Webhook subscription management
    if (url.pathname === "/webhooks" && request.method === "POST") {
      const body = await request.json();
      const id = newId("rwh");
      await env.DB.prepare(
        "INSERT INTO rule_webhooks (id, url, event_types, secret) VALUES (?, ?, ?, ?)"
      ).bind(id, body.url, JSON.stringify(body.event_types || ["rule.*"]), body.secret || null).run();
      return Response.json({ ok: true, id });
    }
    
    if (url.pathname === "/webhooks" && request.method === "GET") {
      const hooks = await env.DB.prepare("SELECT id, url, event_types, created_at FROM rule_webhooks").all();
      return Response.json({ ok: true, webhooks: hooks.results });
    }
    
    if (url.pathname.startsWith("/webhooks/") && request.method === "DELETE") {
      const id = url.pathname.split("/")[2];
      await env.DB.prepare("DELETE FROM rule_webhooks WHERE id = ?").bind(id).run();
      return Response.json({ ok: true });
    }
    
    return Response.json({ ok: false }, { status: 404 });
  },
};

# 事件驱动规则层：需求与开发文档

> 状态：设计中（2026-10-02）
> 决策人：用户已确认架构方向，细节由 Eric 定

---

## 一、需求文档

### 1.1 背景

abot 有多个数据服务（mail 存档、data 的日历/联系人/笔记），共用一个 D1 但服务独立。现在需要它们之间能互通：

- 邮件来了，AI 发现是验证码 → 通知给等码的人
- 邮件来了，AI 发现是会议邀请 → 建日历事件
- 以后 SMS 来了，同样处理
- 日历到期，要发邮件提醒

### 1.2 目标

建一个**独立、可停**的规则层 Worker，订阅所有数据变更事件，用 AI 做简单判定，按规则路由到正确的地方。

### 1.3 非目标（v1 不做）

- 中央数据总线（所有数据必经单点）——太重，单点故障
- 复杂工作流引擎——v1 只要"判定 + 路由"
- 双向自动同步——先做单向（mail/SMS → 日历/通知）

### 1.4 功能需求

**核心定位**：规则层是平台，用户/agent 自定义规则。v1 建引擎和 API，不硬编码具体规则。

| ID | 需求 | 优先级 |
|---|---|---|
| FR-1 | 所有写操作发事件到队列 | P0 |
| FR-2 | 事件格式统一（claim check，只传 ID） | P0 |
| FR-3 | 规则引擎：事件 → 匹配规则 → 执行动作 | P0 |
| FR-4 | 规则 CRUD API（用户/agent 可添加） | P0 |
| FR-5 | 动作原语：webhook、发事件、AI 判定 | P0 |
| FR-6 | 失败重试 + 死信 | P0 |
| FR-7 | 规则层可独立启停 | P0 |

**示例规则**（文档用，不硬编码）：
- 验证码转发：`email.received` + AI 判定是验证码 → webhook
- 会议邀请：`email.received` + AI 判定是邀请 → 发 `rule.calendar_suggestion` 事件

### 1.5 用例

**UC-1：验证码**
1. 用户在某网站点"发送验证码"
2. 邮件/SMS 到达，mail/SMS Worker 存 D1
3. 发 `email.received` 事件到队列（带 email_id）
4. 规则层消费 → 查邮件 → AI 识别出验证码 `123456`
5. 查 pending 表：谁在等这个发件人的码？
6. 找到 → webhook 推给等待方（或发 `rule.verification_code` 事件）

**UC-2：会议邀请**
1. 收到会议邀请邮件
2. 规则层 AI 识别 → 提取标题、时间、地点
3. 发 `rule.calendar_suggestion` 事件
4. （v1 先只发事件，不自动建日历，等用户确认要不要自动建）

### 1.6 非功能需求

| ID | 需求 |
|---|---|
| NFR-1 | 验证码场景端到端 < 30 秒 |
| NFR-2 | 规则层停机不影响 mail/data 读写 |
| NFR-3 | 事件不丢（队列重试 + 死信） |
| NFR-4 | 同一事件重复投递不重复处理（event_id 去重） |
| NFR-5 | **旁路原则**：队列停了，主流程不受影响。事件发送是 best-effort，失败只记日志，不抛异常、不阻塞主写操作 |

---

## 二、开发文档

### 2.1 架构

```
┌─────────────┐     ┌─────────────┐
│ mail Worker │     │ data Worker │
│  (收/发邮件) │     │ (日历/联系人) │
└──────┬──────┘     └──────┬──────┘
       │ 写 D1            │ 写 D1
       ▼                  ▼
┌─────────────────────────────────┐
│         共享 D1                  │
│  emails / calendar_events / ...  │
└─────────────────────────────────┘
       │                  │
       │ 发事件            │ 发事件
       ▼                  ▼
┌─────────────────────────────────┐
│      rule-events Queue           │
│  {event_id, type, at, source,    │
│   email_id/calendar_id/...}      │
└──────────────┬──────────────────┘
               ▼
┌─────────────────────────────────┐
│      abot-rules Worker           │
│  ┌──────────┐  ┌──────────────┐  │
│  │ AI 判定   │→ │ 规则路由      │  │
│  │ (分类提取) │  │ (查pending   │  │
│  └──────────┘  │  发事件/webhook)│
│                └──────────────┘  │
│  Bindings: D1, AI               │
│  可独立启停                      │
└─────────────────────────────────┘
```

### 2.2 事件信封（统一格式）

```json
{
  "event_id": "evt_abc123",
  "type": "email.received",
  "at": "2026-10-02T10:38:00.000Z",
  "source": "mail-worker",
  "email_id": "fbc8ffdb-4303-4aa3-9..."
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `event_id` | ✓ | 全局唯一，`evt_` 前缀 + 时间 + 随机 |
| `type` | ✓ | `email.received`、`calendar.created` 等 |
| `at` | ✓ | ISO8601，事件发生时间 |
| `source` | ✓ | `mail-worker`、`abot-data` |
| `<entity>_id` | ✓ | `email_id`、`calendar_id` 等，按 type 定 |

### 2.3 事件类型清单

| Type | 生产者 | 实体表 |
|---|---|---|
| `email.received` | mail Worker | `emails` |
| `email.sent` | mail Worker | `emails` |
| `calendar.created` | data Worker | `calendar_events` |
| `calendar.updated` | data Worker | `calendar_events` |
| `calendar.deleted` | data Worker | `calendar_events` |
| `contact.created/updated` | data Worker | `contacts` |
| `note.created/updated` | data Worker | `notes` |
| `sms.received` | SMS Worker（未来） | `sms` |
| `rule.verification_code` | abot-rules | —（衍生） |
| `rule.calendar_suggestion` | abot-rules | —（衍生） |

### 2.4 队列设计

- **名称**：`rule-events`
- **DLQ**：`rule-events-dlq`
- **生产者**：mail Worker、data Worker（发事件时）
- **消费者**：abot-rules Worker（queue consumer，非 cron）
- **重试**：3 次后进死信
- **消息大小**：< 1KB（只传 ID）

**创建命令**（Cloudflare API）：
```bash
# 主队列
POST /accounts/{id}/queues
{"name": "rule-events"}

# DLQ
POST /accounts/{id}/queues
{"name": "rule-events-dlq"}
```

**生产者发送模式**（旁路，best-effort）：
```js
// mail Worker 示例
async function emitRuleEvent(env, event) {
  try {
    await env.RULE_EVENTS.send({
      event_id: `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`,
      type: "email.received",
      at: new Date().toISOString(),
      source: "mail-worker",
      email_id: email.resend_id,
    });
  } catch (e) {
    console.error(JSON.stringify({msg: "rule event send failed", error: e.message}));
    // 不抛异常，主流程继续
  }
}
```

**消费者模式**（abot-rules）：
```js
export default {
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        await processRuleEvent(env, msg.body);
        msg.ack();
      } catch (e) {
        console.error(`rule failed: ${msg.body.event_id}`);
        msg.retry();  // 3次后自动进 DLQ
      }
    }
  }
}
```

### 2.5 规则引擎

**规则定义**（存 D1 `rules` 表）：

```json
{
  "id": "rule_xxx",
  "name": "验证码转发",
  "trigger": {"type": "email.received"},
  "condition": {"ai_prompt": "这封邮件是否包含验证码？只回 JSON {\"is_code\":true/false,\"code\":\"...\"}"},
  "actions": [
    {"type": "webhook", "url": "https://...", "secret": "..."}
  ],
  "enabled": true
}
```

**执行流程**：
```
收到队列消息
  → 查 rule_processed 去重
  → 查 rules 表，trigger.type 匹配的启用规则
  → 对每条规则：
      → 按需查 D1 拿实体数据
      → 跑 condition.ai_prompt（如果有）
      → 条件通过 → 执行 actions
  → 记 rule_processed
```

**动作原语**（v1）：
- `webhook`：POST 到 URL，带 HMAC 签名
- `emit_event`：发衍生事件到事件总线
- （未来）`write_calendar`、`send_email` 等

### 2.6 规则管理 API

```
POST   /rules          创建规则
GET    /rules          列出规则
GET    /rules/:id      查规则
PUT    /rules/:id      更新规则
DELETE /rules/:id      删除规则
POST   /rules/:id/enable   启用
POST   /rules/:id/disable  停用
```

### 2.7 验证码 pending 表

```sql
CREATE TABLE rule_pending_codes (
  id TEXT PRIMARY KEY,
  waiter TEXT NOT NULL,        -- 谁在等（agent_id 或 webhook_url）
  sender_pattern TEXT,         -- 发件人匹配（如 "noreply@example.com" 或 "*@example.com"）
  created_at TEXT,
  expires_at TEXT,             -- 超时自动清理
  notified_at TEXT             -- 已通知后标记
);
```

注册接口：`POST /rules/wait-code {waiter, sender_pattern, ttl_seconds}`

### 2.8 Webhook 外发

- 规则层自带 `rule_webhooks` 表：`{id, url, event_types[], secret}`
- 衍生事件发出后，匹配订阅的 webhook 即时 POST
- 签名：`x-abot-signature: v1=<hmac-sha256>`
- 管理接口：`POST/GET/DELETE /webhooks`

### 2.9 D1 Schema

```sql
-- 规则定义
CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,      -- 如 "email.received"，支持 "email.*" 通配
  condition_json TEXT,             -- {"ai_prompt": "..."} 或 NULL（无条件）
  actions_json TEXT NOT NULL,      -- [{"type":"webhook","url":"..."}, ...]
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);

-- 已处理事件去重
CREATE TABLE IF NOT EXISTS rule_processed (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Webhook 订阅
CREATE TABLE IF NOT EXISTS rule_webhooks (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  event_types TEXT NOT NULL,       -- JSON ["rule.*"]
  secret TEXT,                     -- HMAC 密钥，可空
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 验证码等待（示例规则用，v1 可选）
CREATE TABLE IF NOT EXISTS rule_pending_codes (
  id TEXT PRIMARY KEY,
  waiter TEXT NOT NULL,
  sender_pattern TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at TEXT,
  notified_at TEXT
);
```

### 2.10 规则匹配逻辑

```js
function triggerMatches(ruleTrigger, eventType) {
  if (ruleTrigger === "*") return true;
  if (ruleTrigger.endsWith(".*")) {
    return eventType.startsWith(ruleTrigger.slice(0, -1));
  }
  return ruleTrigger === eventType;
}
```

### 2.11 条件求值

```js
async function evaluateCondition(env, rule, entityData) {
  const cond = JSON.parse(rule.condition_json || "{}");
  if (!cond.ai_prompt) return { pass: true };  // 无条件直接通过
  
  // AI 判定
  const result = await env.AI.run(AI_MODEL, {
    messages: [{
      role: "user",
      content: `${cond.ai_prompt}\n\n数据：${JSON.stringify(entityData).slice(0, 2000)}`
    }],
    max_tokens: 300,
  });
  try {
    const parsed = JSON.parse(result.response.match(/\{[^}]+\}/)[0]);
    return { pass: parsed.pass !== false, data: parsed };
  } catch {
    return { pass: false };  // AI 失败 → 条件不通过，不执行动作
  }
}
```

### 2.12 动作执行

```js
async function executeActions(env, rule, event, conditionData) {
  const actions = JSON.parse(rule.actions_json);
  for (const action of actions) {
    if (action.type === "webhook") {
      await sendWebhook(action.url, action.secret, {
        rule_id: rule.id,
        event,
        extracted: conditionData,
      });
    } else if (action.type === "emit_event") {
      await emitDerivedEvent(env, action.event_type, {
        ...conditionData,
        source_rule: rule.id,
        source_event: event.event_id,
      });
    }
  }
}
```

### 2.13 API 认证

规则管理 API（`POST /rules` 等）需要认证：
- v1：简单的 Bearer token（`RULES_API_TOKEN`，Worker secret）
- 请求头：`Authorization: Bearer <token>`
- 未来可接 abot-data 的 OAuth（暂不做）

### 2.14 测试计划

1. **单元测试**：规则匹配、条件求值、动作执行（mock AI 和 D1）
2. **集成测试**：发测试事件到队列 → 规则触发 → webhook 收到
3. **端到端**：发测试邮件 → mail Worker 存 → 队列 → 规则 AI 判定 → webhook
4. **故障测试**：停掉规则 Worker → mail 照常收信；队列满 → 主流程不受影响

### 2.9 去重与幂等

- 队列可能重复投递 → `rule_processed(event_id)` 表去重
- D1 写入用 `INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`
- Webhook 推送失败不重试（v1），只记日志

### 2.10 部署

| Worker | Bindings | Triggers |
|---|---|---|
| `resend-agent-mail-relay` | D1（统一）, R2, AI, Queue(mail-ingest) | Resend webhook |
| `abot-data` | D1（统一）, Queue(abot-deliver), DO, SELF | cron 每分钟 |
| `abot-rules` | D1（统一）, AI, Queue(rule-events consumer) | queue |

### 2.11 待定事项

- [ ] data Worker 的 CRUD 事件发射具体位置（`createEvent` 等函数内）
- [ ] 验证码 waiter 的注册方式（MCP 工具？HTTP API？）
- [ ] `rule.calendar_suggestion` 是否自动建日历，还是只发事件等人确认
- [ ] SMS Worker 什么时候做（v1 不做，但表结构预留）

---

## 三、开发步骤

1. 建 `rule-events` 队列 + DLQ
2. mail Worker：存完发队列消息
3. data Worker：CRUD 发队列消息
4. abot-rules：queue consumer + AI + 规则 + webhook
5. 建 `rule_pending_codes`、`rule_processed`、`rule_webhooks` 表
6. 端到端测试（发测试邮件 → 验证码识别 → webhook 收到）
7. 文档更新（INTEGRATION.md 加规则层说明）

---
name: rules
description: "管理 abot-rules 规则引擎上的规则：创建、列出、按 id 查询、更新、删除。规则按事件类型触发（如 email.received，或 email.* 通配），条件是可选的 AI prompt，动作是 webhook 或 emit_event。当用户要添加自动化、查看已有规则、修改触发条件或动作、启用或停用规则时使用。调用经网关 abot.run，用 abot-mcp CLI。工具参数以 references/tools.md 为准。"
---

# abot-rules

独立规则引擎 Worker（旁路）。消费 `rule-events` 队列，用用户或 agent 定义的规则做匹配：事件类型命中后，可选地用 AI 判定条件，再执行动作。停掉本服务不影响邮件和数据服务的读写。

MCP 服务标识（`initialize` 返回）：`serverInfo.name` 为 `abot-rules-mcp`，`version` 为 `1.0.0`，`protocolVersion` 为 `2025-06-18`。支持的方法：`initialize`、`tools/list`、`tools/call`。

规则存在 D1 `rules` 表。一条规则包含：

- `trigger_type`：事件类型。`*` 匹配全部；以 `.*` 结尾时按前缀匹配（`email.*` 匹配 `email.received`）。
- `condition`：对象，可空。有 `ai_prompt` 时用 Workers AI 判定；没有 `ai_prompt` 时条件直接通过。
- `actions`：动作数组。类型只有 `webhook`（POST 到允许的 https URL，可选 HMAC secret）和 `emit_event`（写入衍生事件）。

工具名、中文描述和参数以 [references/tools.md](references/tools.md) 为准，该文件提取自 `src/worker.js` 的 `MCP_TOOLS`。

## 认证

经网关 **abot.run**，用 **abot-mcp** CLI 调用。不要直连 Worker。

网关通过 Service Binding 把请求转到本服务的 `POST /mcp`，并设置 `X-Abot-Owner-Email`。该头必填：缺失或空白时返回 401，错误信息为 `X-Abot-Owner-Email required`。本服务不校验 `X-Internal-Token`。

`create_rule` 把网关传入的 owner email 写入规则。`list_rules`、`get_rule` 只看到 `owner_email` 为空（历史规则）或等于当前 owner 的规则；`update_rule`、`delete_rule` 只能操作 `owner_email` 等于当前 owner 的规则，历史规则对所有人只读。

## 使用示例

下面的 JSON 是 `abot-mcp` 经网关 `abot.run` 转发到 `POST /mcp` 的 `tools/call` 消息。`arguments` 只使用 `MCP_TOOLS` 里声明的字段。

列出当前 owner 可见的规则（无参数）：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "list_rules", "arguments": {} }
}
```

创建一条规则。`name`、`trigger_type`、`actions` 必填。`actions` 在运行时还要满足：非空数组、最多 20 条；`webhook` 要有允许的 `url`（公网 https，不能带账号密码，不能指向本机、内网或链路本地地址），`secret` 若出现必须是字符串；`emit_event` 要有匹配 `^[A-Za-z0-9.*_\-]{1,200}$` 的 `event_type`。`name` 最长 200 字符，`trigger_type` 用同一套字符规则。

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "create_rule",
    "arguments": {
      "name": "验证码转发",
      "trigger_type": "email.received",
      "condition": { "ai_prompt": "这封邮件是否包含验证码？只返回 JSON。" },
      "actions": [
        { "type": "webhook", "url": "https://example.com/hook", "secret": "hook-secret" }
      ]
    }
  }
}
```

成功时返回 `{ "id": "rule_..." }`。创建时规则为启用；停用走 `update_rule` 的 `enabled`。

按 id 查询、停用、删除：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": { "name": "get_rule", "arguments": { "id": "rule_xxx" } }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "update_rule",
    "arguments": { "id": "rule_xxx", "enabled": false }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": { "name": "delete_rule", "arguments": { "id": "rule_xxx" } }
}
```

`get_rule` 找不到时返回 `{ "error": "not found" }`。`update_rule` 没有可更新字段时返回 `{ "ok": false, "error": "nothing to update" }`；记录不在当前 owner 范围内时，更新和删除返回 `{ "ok": false, "error": "not found" }`。校验失败（用户可见错误）以 JSON-RPC 错误码 `-32602` 返回。

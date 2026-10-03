# MCP 工具

提取自 `src/worker.js` 常量 `MCP_TOOLS`。下面只列源码 `inputSchema` 里的字段。标 `*` 的参数出现在该工具的 `required` 数组中。字段说明只保留源码里写了 `description` 的文字。

## create_rule

创建规则：trigger（事件类型）+ condition（AI prompt）+ actions（webhook/发事件）

| 参数 | 类型 | 必填 | 源码说明 |
|---|---|---|---|
| `name` | string | * | |
| `trigger_type` | string | * | 如 email.received，支持 email.* 通配 |
| `condition` | object | | {ai_prompt: '...'}，可空 |
| `actions` | array，元素为 object | * | |

## list_rules

列出所有规则

无参数。`inputSchema` 为 `{ "type": "object", "properties": {} }`，没有 `required`。

## get_rule

查一条规则

| 参数 | 类型 | 必填 | 源码说明 |
|---|---|---|---|
| `id` | string | * | |

## update_rule

更新规则

| 参数 | 类型 | 必填 | 源码说明 |
|---|---|---|---|
| `id` | string | * | |
| `name` | string | | |
| `trigger_type` | string | | |
| `condition` | object | | |
| `actions` | array | | |
| `enabled` | boolean | | |

## delete_rule

删除规则

| 参数 | 类型 | 必填 | 源码说明 |
|---|---|---|---|
| `id` | string | * | |

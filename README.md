# abot-rules

独立规则引擎 Worker（旁路系统）。

订阅 `rule-events` 队列，用户/agent 自定义规则（trigger + condition + action），AI 做简单判定后路由。

设计文档见 DESIGN.md。

## 部署

**唯一的部署方式是 `npm run deploy`**（`scripts/deploy.mjs`）。不要在 Cloudflare 控制台上传/编辑代码，也不要直接运行 `wrangler deploy`。

```bash
npm ci
npm run deploy:check   # 预检 + 测试 + wrangler dry-run，不需要凭据，不会部署
npm run deploy         # 正式部署到 Cloudflare 账号里的 abot-rules Worker
```

`npm run deploy` 依次执行：

1. 只允许 `main` 分支、工作区干净、且 HEAD 与 `origin/main` 一致。
2. 校验 `wrangler.jsonc`：`workers_dev`/`preview_urls` 必须为 `false`、不允许 routes、`rule-events` 必须挂 `rule-events-dlq`。
3. `npm test`。
4. `wrangler deploy --dry-run` 打包检查。
5. `wrangler deploy --strict`，版本 tag/message 记录 commit SHA。若线上配置在控制台被改过、与 `wrangler.jsonc` 冲突，`--strict` 会拒绝部署，需先把变更同步进 `wrangler.jsonc`。

本地/CI 运行需要环境变量 `CLOUDFLARE_API_TOKEN`（用控制台的 “Edit Cloudflare Workers” 令牌模板创建，并确保包含 Queues: Edit，用于更新 `rule-events` 消费者配置）。

### 在 Cloudflare 控制台（Workers Builds）中使用

仓库连接到 Workers Builds 后（需 GitHub/GitLab 仓库），在 Worker → Settings → Build 中设置：

| 字段 | 值 |
|---|---|
| Production branch | `main` |
| Build command | `npm ci` |
| Deploy command | `npm run deploy` |
| Non-production branch deploy command | `npm run deploy:check` |

脚本会通过 `WORKERS_CI=1` 识别 Workers Builds 环境，并使用其注入的 `WORKERS_CI_BRANCH`/`WORKERS_CI_COMMIT_SHA`。

### 安全约束

`/mcp` 不校验 token，只信任网关设置的 `X-Abot-Owner-Email`，因此这个 Worker 只能通过 `abot-gateway` 的 Service Binding（`BACKEND_RULES`）访问，绝不能开启 workers.dev、预览 URL、路由或自定义域名。

### Secrets

用 `npx wrangler secret put <NAME>` 设置，不进仓库：

- `RULES_API_TOKEN`：`/rules`、`/webhooks` 的 Bearer token；未设置时这些接口全部 401（fail closed）。

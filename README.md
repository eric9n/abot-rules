# abot-rules

独立规则引擎 Worker（旁路系统）。

订阅 `rule-events` 队列，用户/agent 自定义规则（trigger + condition + action），AI 做简单判定后路由。

设计文档见 DESIGN.md。

## 部署

**唯一的部署方式是 `npm run deploy`**（`scripts/deploy.mjs`）。不要在 Cloudflare 控制台上传/编辑代码，也不要直接运行 `wrangler deploy`。

```bash
npm ci                 # 安装依赖（含锁定版本的 wrangler）
npm test               # 单元测试
npm run build          # 打包到 dist/（wrangler dry-run），不需要凭据
npm run deploy:check   # 预检 + 测试 + 打包，不需要凭据，不会部署
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
| Git branch（生产分支） | `main` |
| Build command | 留空（Workers Builds 会按 `package-lock.json` 自动安装依赖） |
| Deploy command | `npm run deploy` |
| Preview command | `npm run deploy:check` |
| Root directory | 留空（`/`） |
| API token | 默认自动生成的即可；需包含 Queues 编辑权限 |
| Build variables and secrets | 不需要 |

Preview command 不能用默认的 `npx wrangler preview`：Preview URL 是公网地址，会让 `/mcp` 暴露在公网上。

脚本会通过 `WORKERS_CI=1` 识别 Workers Builds 环境，并使用其注入的 `WORKERS_CI_BRANCH`/`WORKERS_CI_COMMIT_SHA`。

### 安全约束

`/mcp` 不校验 token，只信任网关设置的 `X-Abot-Owner-Email`，因此这个 Worker 只能通过 `abot-gateway` 的 Service Binding（`BACKEND_RULES`）访问，绝不能开启 workers.dev、预览 URL、路由或自定义域名。

### Secrets

用 `npx wrangler secret put <NAME>` 设置，不进仓库：

- `RULES_API_TOKEN`：`/rules`、`/webhooks` 的 Bearer token；未设置时这些接口全部 401（fail closed）。

```bash
openssl rand -hex 32 | npx wrangler secret put RULES_API_TOKEN
npx wrangler secret delete INTERNAL_TOKEN   # 历史遗留，代码已不再使用
```

注意 `secret put`/`secret delete` 会立即生成并上线一个新版本。

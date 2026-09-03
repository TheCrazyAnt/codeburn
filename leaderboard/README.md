# CodeBurn 排行榜后端（Cloudflare Worker + D1）

CodeBurn 的**自愿加入**公开排行榜服务。macOS 客户端在用户开启「排行榜」后，
定期把自己的 AI 编程花费**汇总数字**上传到这里；本服务负责 GitHub 身份校验、
反作弊规则、榜单查询，以及 `GET /` 的公开网页。

接口契约见 `API.md`（客户端与后端共用同一份文档），本 README 只讲部署和运维。

---

## 1. 存了什么、没存什么

| 存 | 不存 |
| --- | --- |
| GitHub 数字 id、login、头像 URL（公开资料） | GitHub access token（换取会话后立即丢弃，**从不落库**） |
| 本月 / 累计的花费 USD、token 数、调用次数 | 项目名、会话内容、prompt、文件路径、模型明细 |
| 各工具（claude / codex / …）的花费拆分里**最高的那一个** id（`top_provider`） | 邮箱、IP、地理位置 |
| 会话 token 的 **SHA-256 哈希**（原文只返回给客户端一次） | 明文会话 token |
| 最近 500 条上报的审计日志（时间、月花费、累计花费、是否被标记） | — |

所有金额都是美元原始值（客户端按自己汇率显示）。所有时间戳为 ISO-8601 UTC。

### 隐私模型

- **默认关闭。** 客户端 `CodeBurnLeaderboardEnabled` 默认 `false`，且必须先登录 GitHub 才会上传。
- **只上传聚合数字。** 见上表。
- **一个 GitHub 账号 = 一个用户。** `users.id` 就是 GitHub 用户 id。
- **用户可随时删除。** `DELETE /v1/me` 一次性删掉 users / sessions / monthly / reports 中该用户的全部数据（客户端里的「删除我的数据」）。`POST /v1/logout` 只吊销当前这个会话 token。
- **公开榜单只暴露公开信息**：login、头像、花费数字。被反作弊规则标记（`flagged=1`）或手工 `opt_out=1` 的用户不会出现在任何公开榜单里，但本人仍能通过带 token 的 `GET /v1/leaderboard` 看到自己的 `me`（含 `flagged: true`）。
- 只有 `GET /v1/leaderboard` 允许跨域（公开数据），其余接口不开 CORS。

### 反作弊（尽力而为，不是密码学证明）

`POST /v1/report` 按 `API.md` 执行：

| 规则 | 结果 |
| --- | --- |
| 数字非有限或 < 0、字段缺失、`month` 格式错 | `400 invalid_field` |
| `monthUSD > lifetimeUSD × 1.01`；`monthTokens > lifetimeTokens` | `422 implausible` |
| `lifetimeUSD` 比上次低超过 10 % | `422 implausible` |
| 10 分钟内已接受过一次上报 | `429 rate_limited`（带 `retryAfterSeconds`） |
| 增长上限：`Δlifetime ≤ 3000 × max(1, 小时数/24) + 500` 超出 | 接受，但 `flagged=1` |
| 每百万 token 花费不在 `[0.02, 300]` USD 内（`lifetimeTokens > 0` 时） | 接受，但 `flagged=1` |

`flagged` 一旦置 1 就保持（响应里始终返回 `flagged: true`），需要人工在 D1 里
`UPDATE users SET flagged = 0 WHERE id = …` 才能恢复。第一次上报没有「上一次」可比，
因此不做「跌幅」与「增长上限」检查，只做费用/ token 合理性检查。

额外的输入校验（契约未细说、但属于 400 范畴）：`month` 必须是当前 UTC 月份或相邻的前后一个月；
`byProvider` 最多 32 项、id 只允许 `[A-Za-z0-9_.-]{1,32}`；请求体最大 16 KB（超出 `413 payload_too_large`）。

---

## 2. 创建 GitHub OAuth App（开启 Device Flow）

客户端用 GitHub Device Flow 登录，**不需要 client secret**，只需要一个 Client ID：

1. 打开 GitHub → 右上角头像 → **Settings** → 左侧最底部 **Developer settings** → **OAuth Apps** → **New OAuth App**。
2. 表单随便填：
   - Application name：`CodeBurn Leaderboard`
   - Homepage URL：`https://github.com/TheCrazyAnt/codeburn`（任意可访问的 URL 即可）
   - Authorization callback URL：同上（Device Flow 不会用到，但字段必填）
3. **勾选「Enable Device Flow」**（这一步不能漏，否则客户端第一步就会 404）。
4. 点 **Register application**，复制页面上的 **Client ID**（形如 `Iv1.xxxxxxxx` 或 `Ov23li…`）。
   不需要生成 client secret。
5. 把它填进 `wrangler.toml`：`GITHUB_CLIENT_ID = "<刚复制的 Client ID>"`。

客户端只申请空 scope（仅公开资料），服务端用 `GET https://api.github.com/user` 校验 token 并读取 id / login / avatar。

---

## 3. 部署步骤

前提：Node 22+，本目录执行 `npm install`。

```bash
cd leaderboard

# 1) 登录 Cloudflare（浏览器授权）
npx wrangler login

# 2) 创建 D1 数据库，把输出里的 database_id 粘贴到 wrangler.toml 的 [[d1_databases]].database_id
npx wrangler d1 create codeburn-leaderboard

# 3) 在线库上执行 migrations/
npm run migrate:remote

# 4) 在 wrangler.toml 里填好 GITHUB_CLIENT_ID（见第 2 节），按需调整
#    UPLOAD_INTERVAL_MINUTES（默认 60）和 MIN_APP_VERSION（默认 0.9.23）

# 5) 部署
npm run deploy
```

部署完成后 wrangler 会打印 Worker 的 URL（形如 `https://codeburn-leaderboard.<你的子域>.workers.dev`）。
把它写进 Swift 客户端的默认 Base URL，或者用户可通过 UserDefaults `CodeBurnLeaderboardServer` 覆盖。

验证：

```bash
curl https://<worker-url>/healthz          # ok
curl https://<worker-url>/v1/config        # 应看到你的 githubClientId
open https://<worker-url>/                 # 公开网页
```

### 后续维护

- 新增迁移：在 `migrations/` 里加 `0002_xxx.sql`，然后 `npm run migrate:remote`。
- 手工处理某用户：`npx wrangler d1 execute codeburn-leaderboard --remote --command "UPDATE users SET flagged = 0 WHERE login = 'octocat'"`。
- `opt_out` 列没有对应接口，是留给运维手工把某人从公开榜单摘掉用的（数据仍保留，本人仍能看 `me`）。

---

## 4. 本地开发与测试

```bash
npm install
npm run migrate:local      # 在本地 .wrangler/ 下的 SQLite 上建表
npm run dev                # wrangler dev，默认 http://localhost:8787
npm test                   # vitest（在 workerd 里跑，含真实的本地 D1）
npm run typecheck          # tsc --noEmit
scripts/smoke.sh           # 启动 wrangler dev --local，curl 各公开接口，然后自动关闭
```

### 测试是怎么做的

- `test/rules.test.ts`：纯函数单元测试，覆盖 `src/rules.ts` 里的输入校验、422 / 标记规则、限流计算、`topProvider`。
- `test/api.test.ts`：端到端测试。用 `@cloudflare/vitest-pool-workers`（vitest 4 + `cloudflareTest()` 插件）
  把 Worker 跑在 workerd 里，`migrations/` 在每个用例前自动重新应用到本地 D1（`reset()` + `applyD1Migrations()`）。
  对 GitHub 的外呼通过 `vi.stubGlobal("fetch", …)` 拦截（Worker 与测试在同一个 isolate），
  每个用例事先排好 `GET https://api.github.com/user` 的应答并校验请求头（`Authorization: Bearer …`、`User-Agent: codeburn-leaderboard`、`Accept: application/vnd.github+json`）。
  覆盖：会话换取（成功 / 401 / 502 / 400 / 413）、鉴权与 logout、上报接受与落库、422 规则、限流 429、
  增长上限与费用合理性标记、标记粘性与 `me.flagged`、monthly upsert 与 reports 500 条上限、
  榜单排序 / 排除 / limit / month / 缓存头 / CORS、`DELETE /v1/me`。
- 时间相关的规则（10 分钟限流、按小时数放宽的增长上限）通过直接改写 D1 里的 `users.last_report_at` 来模拟时间流逝，不依赖假时钟。

注：`@cloudflare/vitest-pool-workers` 0.22（配合 vitest 4）已经移除了旧的 `cloudflare:test` `fetchMock`
和 `isolatedStorage` 选项，所以这里用全局 `fetch` 桩和每用例 `reset()` 代替；效果等价。

---

## 5. 目录结构

```
leaderboard/
├── wrangler.toml            # Worker 名、D1 绑定 DB、vars
├── migrations/0001_init.sql # users / sessions / monthly / reports + 索引
├── src/
│   ├── index.ts             # 路由与各接口处理（fetch handler）
│   ├── rules.ts             # 纯函数：校验、反作弊、限流
│   ├── auth.ts              # 会话 token 生成 / SHA-256 / Bearer 解析 / GitHub 校验
│   └── page.ts              # GET / 的公开网页（内联 CSS/JS，简体中文，深浅色自适应）
├── test/                    # vitest（workers pool）
├── scripts/smoke.sh         # 本地 wrangler dev 冒烟
└── vitest.config.ts
```

# mergelens

GitLab AI 代码审查助手。MR 自动审查（行内评论 + 总评 + 风险门禁）、审查规则 Skill 化、AI 可配置可降级、发现一键转 Issue（带判重）。

## 快速开始

### 1. 安装依赖

```bash
npm install
# 如果在代理环境下失败，显式指定代理与镜像源：
# npm install --registry=https://registry.npmmirror.com --proxy=http://<代理地址> --https-proxy=http://<代理地址>
```

### 2. 配置环境变量

Linux / macOS：

```bash
export GITLAB_URL=https://gitlab.example.com
export GITLAB_TOKEN=glpat-xxxx          # api 权限的 access token
export ANTHROPIC_API_KEY=sk-ant-xxxx    # 按 provider 择一：ANTHROPIC/OPENAI/DEEPSEEK_API_KEY
```

Windows（cmd）：

```bat
set GITLAB_URL=https://gitlab.example.com
set GITLAB_TOKEN=glpat-xxxx
set ANTHROPIC_API_KEY=sk-ant-xxxx
```

### 3. 自检

```bash
# 逐项验证 GitLab 连通性、AI key、skill 加载，带具体修复提示
npx tsx src/cli.ts doctor my-group/my-repo
```

**代理与内网**：Node 的 fetch 默认忽略 `HTTP_PROXY`/`HTTPS_PROXY`，mergelens 启动时会自动挂载代理支持。典型的「内网 GitLab + 外网 AI API」环境这样配：

```bash
export HTTPS_PROXY=http://proxy:port      # AI API 走代理出网
export NO_PROXY=gitlab.internal.com       # 内网 GitLab 绕过代理直连
```

### 4. 审查第一个 MR

```bash
# 先 dry-run：只在终端打印审查结果，不向 GitLab 发布任何评论
npx tsx src/cli.ts review my-group/my-repo 42 --dry-run

# 确认效果后正式发布（行内评论 + 总评）
npx tsx src/cli.ts review my-group/my-repo 42
```

装了 make 的话，常用操作都有对应 target（见 `Makefile`）：

```bash
make test                                    # 单元测试
make review P=my-group/my-repo MR=42         # dry-run 审查
make review-post P=my-group/my-repo MR=42    # 正式发布
make serve                                   # 启动 Webhook 服务（默认 3000 端口）
```

## 命令

| 命令 | 说明 |
|---|---|
| `doctor [project]` | 自检：GitLab 认证、项目权限、AI 连通性、skill 加载，逐项给修复提示 |
| `review <project> <iid> [--dry-run] [--full] [--create-issues]` | 审查 MR，发布行内评论和总评；`--create-issues` 时高危/严重发现自动转 Issue（带判重）；有门禁级问题时退出码 1（可做 CI 卡点） |
| `stats` | 审查记录统计：次数、发现分布、拦截率、最近 10 次（数据在 `data/reviews.jsonl`） |
| `summarize <project> <iid> [--update-desc]` | 生成「改了什么/为什么/影响面」摘要，发评论或写入 MR 描述 |
| `issues list <project> [--search q]` | 检索 Issue |
| `issues create <project> --title ...` | 创建 Issue |
| `serve [--port 3000]` | 启动 Webhook 服务，MR open/push 自动触发审查 |
| `config` | 打印生效配置（脱敏） |

## 三种部署形态（按环境选）

| 形态 | 适用场景 | 需要什么 |
|---|---|---|
| **CI 模式**（最简） | GitLab 够不到你的任何机器 / 不想维护服务 | 只要 Runner 能出网调 AI API；零部署 |
| **常驻服务** | 有一台 GitLab 可达的机器 | webhook + 看板 + @ai 对话 + IM 推送全功能 |
| **Docker** | 常驻服务的容器化版本 | 同上，环境更干净 |

### CI 模式（不需要服务器、不需要 webhook）

复制 `.gitlab-ci.example.yml` 到目标仓库，在项目 CI/CD Variables 里配
`MERGELENS_GITLAB_TOKEN` 和 AI key，每个 MR 流水线自动审查：

- `GITLAB_URL` 自动取 `CI_SERVER_URL`，项目和 MR 号自动取 CI 变量，`review` 零参数运行
- `allow_failure: false` 时审查发现门禁级问题直接把流水线打红，形成硬卡点
- 局限：没有看板/@ai 对话/IM 推送（这些需要常驻服务）

### Docker 部署

```bash
docker build --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t mergelens .
docker run -d --name mergelens -p 3000:3000 \
  --env-file .env \
  -v mergelens-data:/app/data \
  mergelens
```

## 后台常驻运行

```bash
npm run build                          # 先编译（后台进程直接跑 dist，更稳）
npx tsx src/cli.ts start --port 3000   # 后台启动，脱离终端，关掉窗口不影响
npx tsx src/cli.ts status              # 运行状态 + 健康检查（队列/近期事件）
npx tsx src/cli.ts logs --lines 200    # 查看日志（data/mergelens.log）
npx tsx src/cli.ts stop                # 停止
```

开机自启/崩溃自动拉起建议再套一层系统级守护：

- **Linux**：systemd unit，`ExecStart=/usr/bin/node /opt/mergelens/dist/cli.js serve`，`Restart=always`
- **Windows**：任务计划程序（触发器=系统启动）或 [NSSM](https://nssm.cc) 注册为系统服务

## 自动触发（Webhook 接入，一个服务管所有项目）

1. 启动服务：上面的 `start`（后台）或 `serve`（前台调试）
2. 配 Webhook——**推荐配在群组级**，组下所有项目一次生效：
   - GitLab **群组** → Settings → Webhooks（项目级同样支持，路径相同）
   - URL：`http://部署机:3000/webhook`
   - Secret token：与环境变量 `WEBHOOK_SECRET` 一致
   - 勾选 **Merge request events** 和 **Comments**（后者用于 @机器人 对话）
3. Token 用**群组 Access Token**（群组 → Settings → Access Tokens，Developer 角色 + api scope），
   一个 token 覆盖组下所有项目，评论显示为独立 bot 身份。
   群组 webhook 也可以命令注册：`mergelens hook install <group> --url ... --group`。
   服务端并发：不同 MR 最多 3 个并行审查，同一 MR 严格串行。
4. 触发规则：**新开 MR、reopen、向 MR 分支 push 新提交**都会自动审查（push 走增量）；
   同一 MR 连续多次触发会排队串行，同一 sha 重复触发直接跳过。

### 创建 MR 没触发？排查清单

1. **GitLab 能不能够到部署机**——在 GitLab 服务器上 `curl http://部署机:3000/health`。
   本地开发机通常在 NAT/防火墙后面，GitLab 够不到它；把服务部署到 GitLab 可达的机器上。
2. GitLab → Settings → Webhooks → 底部 **Recent events**：看有没有投递记录、HTTP 状态码。
   没记录 = webhook 没配对地方或事件没勾；有记录但非 200 = 网络/Secret 问题。
3. 打开 `http://部署机:3000/health`：`recentEvents` 里记录了每个收到的事件和处理决定
   （入队 / 为什么被忽略 / Secret 不匹配），服务日志同步输出。
4. Secret token 两边必须一字不差；不确定就先两边都留空跑通，再加上。

## Web 看板与配置页

`serve` 起来后浏览器打开 `http://部署机:3000/`：累计审查/发现分布/拦截率指标、
最近 14 天审查量、最近 20 次审查明细，60s 自动刷新。JSON 数据在 `/api/reviews`。

> 看板读的是 `data/reviews.jsonl`。CLI 和 serve 在不同目录跑时，用 `MERGELENS_DATA`
> 环境变量指到同一个数据目录。

**配置页 `/config`**：模型、门禁、降噪、忽略路径、skill 开关、推送策略全部可视化编辑，
两个保存目标：

- **保存为服务端默认**：写入服务端 `.ai-review.yml`，立即热生效（不用重启）
- **提交到指定仓库**：通过 GitLab API 向该仓库默认分支提交 `.ai-review.yml`，
  形成项目级配置（覆盖服务端默认）

安全设计：密钥类（GITLAB_TOKEN / AI key / 推送 webhook）**不能**在页面上查看或修改，
只能走环境变量，页面仅显示已配置/未配置状态；写操作可设 `ADMIN_TOKEN` 环境变量加口令保护
（公网部署务必设置）。

## 评论区唤起机器人对话

在 MR 评论里包含**触发词 `@ai`**（可在配置里改，`assistant.trigger`），bot 带着该 MR 的
diff 上下文回复，在原讨论串里回，不另开评论：

- `@ai 这条是误报吧？` —— bot 重新评估：站得住就有理有据地坚持，确属误报会明确承认
- `@ai 这里怎么改比较好` —— 给出可直接粘贴的修复代码
- `@ai 转issue` —— 在某条发现的讨论串里说，把该发现转为 Issue（自动判重，带来源链接）
- `@ai 重新审查` —— 触发全量重审
- `@ai 生成摘要` —— 生成 MR 摘要

在讨论串里**追问**时，bot 会带上该串的历史对话（最近 10 条），上下文不丢。

> 为什么用触发词而不是真 @：项目/群组 Access Token 对应的 bot 用户名是
> `project_123_bot_xxx` 这类，在评论区 @ 补全里搜不到。触发词是纯文本匹配，
> 任何人直接打字就能唤起；真实 @bot用户名（个人 token 场景）也始终有效。
> 前提：webhook 勾选了 **Comments** 事件。

## 采纳率统计与反馈自动调权

bot 的行内评论都是可 resolve 的讨论。**MR 合并时自动结算**：被 resolve 的发现视为
「采纳」，同时统计评论上的 👍/👎 表情。结果进 `data/feedback.jsonl`，看板显示总采纳率。
也可手动结算：`mergelens feedback <project> <mr-iid>`。

**自动调权**：结算时按 skill 归因每条发现的结局（`data/skill-stats.jsonl`）。某 skill
积累 ≥5 条反馈后计算信任系数（采纳率高 → 最高 1.10；采纳率低或净 👎 多 → 最低 0.75），
审查时用系数缩放该 skill 发现的置信度——不被开发者认可的 skill，其发现会更容易被
`min_confidence` 门槛拦下，噪音自动收敛，无需人工调配置。`mergelens stats` 可查看各
skill 当前系数。

## 审查记忆库与风险热力

每次正式审查的发现自动沉淀到 `data/memory.jsonl`，两个用途（全自动，无需配置）：

- **惯犯提级**：同一问题模式在团队出现 ≥2 次后，后续审查的提示词会注入
  「该模式已出现 N 次」，AI 遇到同类问题自动提高一级严重度并点名惯犯
- **风险热力**：历史发现聚集的文件被标记为高风险，MR 涉及这些文件时提示词
  要求从严审查；看板显示全局高风险文件榜，CLI 用 `mergelens heatmap <project>` 查看

## 发布说明生成

```bash
mergelens changelog my-group/my-repo --days 14 --target main
```

拉取时间窗内已合并的 MR，AI（轻量模型）按 ✨新功能 / 🐛修复 / 🔧其他 分组改写成
面向用户的发布说明，带 MR 链接与贡献者统计，输出 markdown 到终端。

## IM 推送（钉钉 / 企业微信）

审查完成后自动推送结果卡片（结论、发现分布、MR 链接）。配置环境变量即启用：

```bash
# 钉钉：群设置 → 智能群助手 → 添加自定义机器人，安全设置建议选「加签」
export DINGTALK_WEBHOOK="https://oapi.dingtalk.com/robot/send?access_token=xxx"
export DINGTALK_SECRET="SECxxx"        # 选了加签才需要

# 企业微信：群右键 → 添加群机器人
export WECOM_WEBHOOK="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx"
```

推送时机在 `.ai-review.yml` 里控制：`notify.on: all | needs-work | off`（默认 needs-work，
只在有阻塞级问题时打扰群里）。推送失败只记日志，不影响审查主流程。

## 配置（两级继承，天然多项目）

```
服务端默认（serve 进程目录的 .ai-review.yml，可选）
  ↑ 被覆盖
各仓库自己的 .ai-review.yml（审查时从 MR 的 target 分支实时拉取）
```

每个仓库把 `.ai-review.yml` 提交到自己的默认分支即可拥有独立配置（模型、门禁、忽略路径、
启用哪些 skill、推送策略），不用动服务端。安全约束：仓库配置从 **target 分支**读取
（MR 作者改自己分支里的配置不生效），且不允许覆盖 `ai.base_url`（防 API key 外带）。

核心配置项（模板见 `.ai-review.example.yml`）：

- `ai.provider / model / fallback`：anthropic / openai / deepseek / ollama，主模型失败自动降级
- `review.verify`：反驳验证——每条发现先由轻量模型尝试推翻，存活的才发布（降误报）
- `review.max_comments / min_confidence`：降噪双闸
- `review.severity_gate`：达到该严重度时总评判定「建议修复后合并」，CLI 退出码 1
- `skills.enabled`：启用哪些审查维度

## Skill（审查规则即 markdown）

两个来源，同名时仓库覆盖内置：

- **内置**：mergelens 自带的 `skills/*.md`（correctness、security）
- **仓库自定义**：各仓库的 **`.mergelens/skills/*.md`**，审查时从 target 分支实时拉取——
  团队规范新增一条 = 往自己仓库提交一个 md 文件，不用碰服务端

**在线编辑**：`serve` 起来后访问 `/skills` —— 内置规则只读展示；仓库自定义规则
在线加载/编辑/新建，保存即向该仓库提交 md 文件；**效果回放**可以在规则上线前
拿一个真实 MR 试跑（不发布任何评论），先看看新规则会报什么，避免上线刷屏。

frontmatter 声明元数据，正文用自然语言写规则：

```markdown
---
name: no-raw-fetch
trigger: "src/**/*.{ts,tsx}"
severity_weight: 0.8
---
本项目禁止直接调用 fetch，必须走 @ecs/http 封装……
```

- `trigger`：文件 glob（逗号分隔多个），MR 没碰到匹配文件时该 skill 不跑
- 内置：`correctness`（逻辑正确性）、`security`（OWASP + 攻击路径）
- 团队规范新增一条 = 新增一个 md 文件，无需改代码

## 审查流水线

```
拉取 MR diff → 忽略过滤 → 大 MR 分片（贪心装箱，≤4 块并行，不再静默丢文件）
  → 解析关联 Issue（校验"改动是否真正解决了 Issue"）→ 脱敏 → 各 skill × 分片并行审查
  → 去重 → 反馈调权 → 置信度门槛 → 反驳验证（质疑者模型尝试推翻）
  → 行内评论（锚定新增行）+ 总评 + 可选 approve 投票 + 大 MR 自动摘要
```

相关配置（`.ai-review.yml` 的 review 段）：

- `redact_patterns`：发给 LLM 前按正则脱敏（内网 IP/域名等），命中替换为 `[已脱敏]`
- `auto_summary_lines: 400`：全量审查 diff 超过该行数自动生成 MR 摘要（0=关）
- `vote: approve`：审查通过自动点 approve、不通过撤销（token 需 approve 权限）
- `daily_token_budget`：每日 token 预算（0=不限），超出后当天跳过审查；
  每次审查的 token 消耗记录在案，看板有消耗卡片
- Issue 联动零配置：MR 描述里引用 `#123` 即自动拉取校验（最多 3 个）

## 增量审查

默认开启（`review.incremental`）。每次审查会在总评里埋一个带 head sha 的隐藏标记：

- push 新提交后再审：只比对 `上次sha..当前head` 的增量 diff，历史发现的标题会喂给模型避免重复唠叨
- 同一个 sha 重复触发（webhook 重发、手动重跑）：直接跳过，不花钱
- 想强制全量重审：`review ... --full`
- 增量定位失败（如 force push 导致旧 sha 不存在）：自动回退全量审查

## 运维

- **日志轮转**：`data/mergelens.log` 超 5MB 时在下次 `start` 自动归档为 `.log.1`（保留一代）
- **失败重试**：webhook 触发的审查失败后按 60s/120s 退避自动重试，连续 3 次失败才放弃（日志可查）
- **HTTPS 反代**（公网/跨网段部署建议）：mergelens 本身只起 HTTP，用 nginx 终结 TLS：

```nginx
server {
    listen 443 ssl;
    server_name mergelens.example.com;
    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_read_timeout 300s;   # 审查耗时可能较长
    }
}
```

  GitLab webhook URL 填 `https://mergelens.example.com/webhook`；配置页/看板同域访问，
  记得设置 `ADMIN_TOKEN`。

## 已知边界（MVP）

- 行内评论只锚定到「新增行」，其他发现进总评表格
- Webhook 只处理 MR 事件；评论区 @机器人 对话是下一期
- 看板是只读的；在线改配置、Skill 在线编辑是下一期

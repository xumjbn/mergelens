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
| `review <project> <iid> [--dry-run] [--full]` | 审查 MR，发布行内评论和总评；有门禁级问题时退出码 1（可做 CI 卡点） |
| `stats` | 审查记录统计：次数、发现分布、拦截率、最近 10 次（数据在 `data/reviews.jsonl`） |
| `summarize <project> <iid> [--update-desc]` | 生成「改了什么/为什么/影响面」摘要，发评论或写入 MR 描述 |
| `issues list <project> [--search q]` | 检索 Issue |
| `issues create <project> --title ...` | 创建 Issue |
| `serve [--port 3000]` | 启动 Webhook 服务，MR open/push 自动触发审查 |
| `config` | 打印生效配置（脱敏） |

## Webhook 接入

1. `npx tsx src/cli.ts serve --port 3000`（生产建议 `npm run build` 后跑 `node dist/cli.js serve`）
2. GitLab 项目 → Settings → Webhooks：
   - URL：`http://部署机:3000/webhook`
   - Secret token：与环境变量 `WEBHOOK_SECRET` 一致
   - 勾选 **Merge request events**
3. 新开 MR 或 push 新提交即自动审查。健康检查：`GET /health`

## 配置

仓库根目录放 `.ai-review.yml`（模板见 `.ai-review.example.yml`），核心项：

- `ai.provider / model / fallback`：anthropic / openai / deepseek / ollama，主模型失败自动降级
- `review.verify`：反驳验证——每条发现先由轻量模型尝试推翻，存活的才发布（降误报）
- `review.max_comments / min_confidence`：降噪双闸
- `review.severity_gate`：达到该严重度时总评判定「建议修复后合并」，CLI 退出码 1
- `skills.enabled`：启用哪些审查维度

## Skill（审查规则即 markdown）

`skills/*.md`，frontmatter 声明元数据，正文用自然语言写规则：

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
拉取 MR diff → 忽略路径过滤 + 行数预算 → 各 skill 并行审查
  → 去重 → 置信度门槛 → 反驳验证（质疑者模型尝试推翻）
  → 行内评论（锚定新增行）+ 总评（含风险表格与门禁结论）
```

## 增量审查

默认开启（`review.incremental`）。每次审查会在总评里埋一个带 head sha 的隐藏标记：

- push 新提交后再审：只比对 `上次sha..当前head` 的增量 diff，历史发现的标题会喂给模型避免重复唠叨
- 同一个 sha 重复触发（webhook 重发、手动重跑）：直接跳过，不花钱
- 想强制全量重审：`review ... --full`
- 增量定位失败（如 force push 导致旧 sha 不存在）：自动回退全量审查

## 已知边界（MVP）

- 行内评论只锚定到「新增行」，其他发现进总评表格
- Webhook 只处理 MR 事件；评论区 @机器人 对话是下一期
- 无持久化：采纳率统计、审查记忆库等看板能力是下一期

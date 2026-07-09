#!/usr/bin/env node
import { loadConfig, requireAiKey, requireToken } from "./config.js";
import { setupProxyFromEnv } from "./net.js";
import { reviewMr } from "./review/pipeline.js";
import { GitLab } from "./gitlab.js";
import { createIssueFromFinding } from "./issues.js";
import { startServer } from "./server.js";
import { doctor } from "./doctor.js";
import { summarizeMr } from "./summarize.js";

const HELP = `mergelens — GitLab AI 代码审查助手

用法：
  mergelens doctor [project]                        自检：GitLab 连通性 / AI key / skills
  mergelens review <project> <mr-iid> [--dry-run]   审查一个 MR（project 可以是 id 或 group/name）
  mergelens summarize <project> <mr-iid> [--dry-run] [--update-desc]   生成 MR 摘要
  mergelens issues list <project> [--search 关键词] [--state opened|closed|all]
  mergelens issues create <project> --title "标题" [--desc "描述"] [--labels a,b]
  mergelens serve [--port 3000]                     启动 Webhook 服务
  mergelens config                                  打印生效配置（脱敏）

环境变量：
  GITLAB_URL          GitLab 地址（默认 https://gitlab.com）
  GITLAB_TOKEN        访问令牌（api 权限，必填）
  ANTHROPIC_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY   按 provider 择一
  WEBHOOK_SECRET      Webhook 校验密钥（serve 模式）
  MERGELENS_CONFIG    .ai-review.yml 路径（默认取当前目录）

配置文件：仓库根目录 .ai-review.yml（见 .ai-review.example.yml）`;

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(flag);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  setupProxyFromEnv(); // Node fetch 默认不认 HTTP(S)_PROXY，这里显式挂上
  const cfg = loadConfig();

  switch (cmd) {
    case "doctor": {
      const ok = await doctor(cfg, rest[0]);
      process.exitCode = ok ? 0 : 1;
      break;
    }

    case "summarize": {
      const [project, iidStr] = rest;
      if (!project || !iidStr) throw new Error("用法：mergelens summarize <project> <mr-iid>");
      requireToken(cfg);
      requireAiKey(cfg);
      const summary = await summarizeMr(cfg, project, parseInt(iidStr, 10), {
        dryRun: has("--dry-run"),
        updateDescription: has("--update-desc"),
      });
      console.log("\n" + summary + "\n");
      break;
    }

    case "review": {
      const [project, iidStr] = rest;
      if (!project || !iidStr) throw new Error("用法：mergelens review <project> <mr-iid>");
      requireToken(cfg);
      requireAiKey(cfg);
      const result = await reviewMr(cfg, project, parseInt(iidStr, 10), { dryRun: has("--dry-run") });
      console.log("\n" + result.summary + "\n");
      if (has("--dry-run")) {
        console.log("--- dry-run：以下行内评论未发布 ---");
        for (const f of result.findings.filter((x) => x.line !== null)) {
          console.log(`\n[${f.severity}] ${f.file}:${f.line} ${f.title}\n  ${f.detail}`);
        }
      }
      process.exitCode = result.verdict === "needs-work" ? 1 : 0;
      break;
    }

    case "issues": {
      const [sub, project] = rest;
      requireToken(cfg);
      const gl = new GitLab(cfg);
      if (sub === "list") {
        const issues = await gl.listIssues(project, {
          search: arg("--search"),
          state: (arg("--state") as any) ?? "opened",
          labels: arg("--labels"),
        });
        for (const i of issues) console.log(`#${i.iid}\t[${i.state}]\t${i.title}\t{${i.labels.join(",")}}`);
        console.log(`\n共 ${issues.length} 条`);
      } else if (sub === "create") {
        const title = arg("--title");
        if (!project || !title) throw new Error("用法：mergelens issues create <project> --title \"...\"");
        const issue = await gl.createIssue(project, {
          title,
          description: arg("--desc") ?? "",
          labels: arg("--labels")?.split(","),
        });
        console.log(`已创建 #${issue.iid} ${issue.web_url}`);
      } else {
        throw new Error("用法：mergelens issues <list|create> ...");
      }
      break;
    }

    case "serve": {
      requireToken(cfg);
      requireAiKey(cfg);
      startServer(cfg, parseInt(arg("--port") ?? "3000", 10));
      break;
    }

    case "config": {
      console.log(JSON.stringify({ ...cfg, gitlabToken: cfg.gitlabToken ? "***" : "(未设置)" }, null, 2));
      break;
    }

    default:
      console.log(HELP);
      if (cmd && cmd !== "--help" && cmd !== "-h") process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error("错误：" + (err as Error).message);
  process.exit(1);
});

export { createIssueFromFinding }; // re-export for programmatic use

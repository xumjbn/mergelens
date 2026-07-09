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
  mergelens review <project> <mr-iid> [--dry-run] [--full]   审查 MR（默认增量：只审上次之后的新提交）
  mergelens stats                                   审查记录统计（数据在 data/reviews.jsonl）
  mergelens changelog <project> [--days 14] [--target 分支]   从已合并 MR 生成发布说明
  mergelens heatmap <project>                       风险热力：高危文件 + 惯犯问题模式
  mergelens summarize <project> <mr-iid> [--dry-run] [--update-desc]   生成 MR 摘要
  mergelens feedback <project> <mr-iid>             手动结算某 MR 的采纳反馈（合并时会自动结算）
  mergelens issues list <project> [--search 关键词] [--state opened|closed|all]
  mergelens issues create <project> --title "标题" [--desc "描述"] [--labels a,b]
  mergelens hook list <project>                     查看项目 webhook 配置（事件勾选情况）
  mergelens hook install <project> --url http://部署机:3000/webhook [--secret s]
                                                    自动注册/修复 webhook（MR + Comments 事件）
  mergelens serve [--port 3000]                     前台启动服务（Ctrl+C 退出）
  mergelens start [--port 3000]                     后台常驻启动（脱离终端）
  mergelens stop                                    停止后台服务
  mergelens status                                  后台服务状态 + 健康检查
  mergelens logs [--lines 100]                      查看后台服务日志
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
  const { loadDotEnv } = await import("./env.js");
  const envFile = loadDotEnv(); // .env 补齐环境变量（已设置的优先）
  if (envFile) console.error(`[env] 已加载 ${envFile}`);
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
      let [project, iidStr] = rest.filter((a) => !a.startsWith("--"));
      // GitLab CI 里可零参数运行：从 CI 预置变量取项目和 MR
      if (!project && process.env.CI_MERGE_REQUEST_IID) {
        project = process.env.CI_PROJECT_PATH ?? process.env.CI_PROJECT_ID ?? "";
        iidStr = process.env.CI_MERGE_REQUEST_IID;
        console.error(`[ci] 检测到 GitLab CI 环境：${project}!${iidStr}`);
      }
      if (!project || !iidStr) throw new Error("用法：mergelens review <project> <mr-iid>（GitLab CI 的 MR 流水线里可省略参数）");
      requireToken(cfg);
      requireAiKey(cfg);
      const result = await reviewMr(cfg, project, parseInt(iidStr, 10), {
        dryRun: has("--dry-run"),
        fullReview: has("--full"),
      });
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

    case "hook": {
      const [sub, project] = rest;
      if (!project) throw new Error("用法：mergelens hook <list|install> <project> [--url ...]");
      requireToken(cfg);
      const gl = new GitLab(cfg);
      if (sub === "list") {
        const hooks = await gl.listProjectHooks(project);
        if (hooks.length === 0) {
          console.log("该项目没有配置任何 webhook。注册：mergelens hook install " + project + " --url http://部署机:3000/webhook");
          break;
        }
        for (const h of hooks) {
          console.log(`#${h.id} ${h.url}`);
          console.log(`   Merge request events: ${h.merge_requests_events ? "✓" : "✗"}   Comments(@ai 需要): ${h.note_events ? "✓" : "✗"}`);
        }
      } else if (sub === "install") {
        const url = arg("--url");
        if (!url) throw new Error("需要 --url，例如 --url http://部署机:3000/webhook");
        const secret = arg("--secret") ?? process.env.WEBHOOK_SECRET;
        const r = await gl.installProjectHook(project, url, secret);
        console.log(`${r.updated ? "已更新" : "已创建"} webhook #${r.id}：${url}`);
        console.log(`  已勾选：Merge request events ✓  Comments ✓${secret ? "  Secret ✓" : "  （无 Secret）"}`);
        console.log(`  下一步：确保 mergelens start 常驻运行，且 GitLab 能访问该 URL（GitLab 服务器上 curl ${url.replace(/\/webhook$/, "/health")}）`);
      } else {
        throw new Error("用法：mergelens hook <list|install> <project>");
      }
      break;
    }

    case "serve": {
      requireToken(cfg);
      requireAiKey(cfg);
      startServer(cfg, parseInt(arg("--port") ?? "3000", 10));
      break;
    }

    case "start": {
      requireToken(cfg);
      requireAiKey(cfg);
      const { daemonStart } = await import("./daemon.js");
      daemonStart(parseInt(arg("--port") ?? "3000", 10));
      break;
    }

    case "stop": {
      const { daemonStop } = await import("./daemon.js");
      daemonStop();
      break;
    }

    case "status": {
      const { daemonStatus } = await import("./daemon.js");
      process.exitCode = (await daemonStatus()) ? 0 : 1;
      break;
    }

    case "logs": {
      const { daemonLogs } = await import("./daemon.js");
      daemonLogs(parseInt(arg("--lines") ?? "100", 10));
      break;
    }

    case "feedback": {
      const [project, iidStr] = rest;
      if (!project || !iidStr) throw new Error("用法：mergelens feedback <project> <mr-iid>");
      requireToken(cfg);
      const { collectFeedback } = await import("./feedback.js");
      const rec = await collectFeedback(cfg, project, parseInt(iidStr, 10));
      console.log(rec
        ? `发现 ${rec.findings} 条，采纳（resolved）${rec.resolved}，👍${rec.up} 👎${rec.down}`
        : "该 MR 上没有 bot 发起的行内讨论");
      break;
    }

    case "changelog": {
      const [project] = rest.filter((a) => !a.startsWith("--"));
      if (!project) throw new Error("用法：mergelens changelog <project> [--days 14] [--target main]");
      requireToken(cfg);
      requireAiKey(cfg);
      const { generateChangelog } = await import("./changelog.js");
      console.log(await generateChangelog(cfg, project, {
        days: parseInt(arg("--days") ?? "14", 10),
        targetBranch: arg("--target"),
      }));
      break;
    }

    case "heatmap": {
      const [project] = rest;
      if (!project) throw new Error("用法：mergelens heatmap <project>");
      const { readMemory } = await import("./store.js");
      const { recurringPatterns, riskyFiles } = await import("./memory.js");
      const mem = readMemory();
      const risky = riskyFiles(mem, project, 1, 15);
      const patterns = recurringPatterns(mem, project, 2, 10);
      if (mem.filter((m) => m.project === project).length === 0) {
        console.log("该项目还没有审查记忆（跑几次正式审查后再来看）");
        break;
      }
      console.log("高风险文件（历史发现聚集）：");
      for (const f of risky) console.log(`  ${String(f.total).padStart(3)} 条（高危/严重 ${f.critical}）  ${f.file}`);
      console.log("\n惯犯问题模式（出现 ≥2 次，审查时自动提级）：");
      if (patterns.length === 0) console.log("  暂无");
      for (const p of patterns) console.log(`  ${String(p.count).padStart(3)} 次  ${p.title}`);
      break;
    }

    case "stats": {
      const { readReviews, formatStats } = await import("./store.js");
      console.log(formatStats(readReviews()));
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

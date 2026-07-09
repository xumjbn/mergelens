import type { Config } from "./types.js";
import { GitLab } from "./gitlab.js";
import { chat } from "./ai.js";
import { loadSkills } from "./skills.js";

const OK = "  ✓";
const FAIL = "  ✗";

/** 逐项自检：配置 → GitLab → AI → skills。返回是否全部通过。 */
export async function doctor(cfg: Config, project?: string): Promise<boolean> {
  let allOk = true;
  const fail = (msg: string, hint?: string): void => {
    allOk = false;
    console.log(`${FAIL} ${msg}`);
    if (hint) console.log(`      提示：${hint}`);
  };

  console.log("mergelens doctor\n");

  /* ---- 1. 配置 ---- */
  console.log("[1/5] 配置");
  console.log(`${OK} GitLab 地址：${cfg.gitlabUrl}`);
  console.log(`${OK} AI：${cfg.ai.provider} / ${cfg.ai.model}` +
    (cfg.ai.fallbackModel ? `（降级 ${cfg.ai.fallbackModel}）` : ""));
  const proxy = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  if (proxy) {
    console.log(`${OK} 代理：${proxy}（NO_PROXY=${process.env.NO_PROXY ?? "未设置"}）`);
    if (!process.env.NO_PROXY && !cfg.gitlabUrl.includes("gitlab.com")) {
      console.log(`      提示：GitLab 若是内网地址，建议设置 NO_PROXY=<gitlab域名> 让它绕过代理直连`);
    }
  }

  /* ---- 2. GitLab ---- */
  console.log("\n[2/5] GitLab 连通性");
  if (!cfg.gitlabToken) {
    fail("GITLAB_TOKEN 未设置", "GitLab → Preferences → Access Tokens，勾选 api scope");
  } else {
    const gl = new GitLab(cfg);
    try {
      const user = await gl.getCurrentUser();
      console.log(`${OK} 认证成功，身份：@${user.username}`);
      if (project) {
        try {
          const issues = await gl.listIssues(project, {});
          console.log(`${OK} 可访问项目 ${project}（开放 issue ${issues.length} 个）`);
        } catch (err) {
          fail(`项目 ${project} 访问失败：${(err as Error).message}`,
            "确认 token 对该项目有权限（项目 token 需要 Developer 角色）");
        }
      }
    } catch (err) {
      const msg = (err as Error).message;
      fail(`GitLab 认证失败：${msg}`,
        msg.includes("401") ? "token 无效或已过期，重新生成并确认勾选了 api scope"
        : msg.includes("fetch failed") ? "网络不通——内网 GitLab 且开着代理时，设置 NO_PROXY=<gitlab域名>"
        : undefined);
    }
  }

  /* ---- 3. AI ---- */
  console.log("\n[3/5] AI 服务");
  const keyName =
    cfg.ai.provider === "anthropic" ? "ANTHROPIC_API_KEY"
    : cfg.ai.provider === "openai" ? "OPENAI_API_KEY"
    : cfg.ai.provider === "deepseek" ? "DEEPSEEK_API_KEY" : null;
  if (keyName && !process.env[keyName]) {
    fail(`${keyName} 未设置`, `provider=${cfg.ai.provider} 需要这个环境变量`);
  } else {
    try {
      const t0 = Date.now();
      const out = await chat(cfg.ai, "你是连通性测试。", "只回复两个字：正常", { maxTokens: 20 });
      console.log(`${OK} ${cfg.ai.model} 响应正常（${Date.now() - t0}ms）：${out.trim().slice(0, 20)}`);
    } catch (err) {
      const msg = (err as Error).message;
      fail(`AI 调用失败：${msg.slice(0, 200)}`,
        msg.includes("fetch failed") ? "网络不通——确认 HTTPS_PROXY 已设置（Node fetch 需要 mergelens 启动时能读到它）"
        : msg.includes("401") || msg.includes("403") ? "API key 无效"
        : msg.includes("404") ? "模型名不对，检查 .ai-review.yml 的 ai.model"
        : undefined);
    }
  }

  /* ---- 4. skills ---- */
  console.log("\n[4/5] Skills");
  const skills = loadSkills(cfg.review.skillsDir, cfg.review.enabledSkills);
  if (skills.length === 0) {
    fail(`未加载到任何 skill（目录 ${cfg.review.skillsDir}）`);
  } else {
    console.log(`${OK} 加载 ${skills.length} 个：${skills.map((s) => s.name).join(", ")}`);
  }

  /* ---- 5. webhook（自动触发与 @ai 的前提）---- */
  console.log("\n[5/5] Webhook（自动审查与评论区 @ai 依赖它）");
  if (!project || !cfg.gitlabToken) {
    console.log(`  - 未指定项目，跳过（用 doctor <project> 检查该项目的 webhook 配置）`);
  } else {
    try {
      const gl = new GitLab(cfg);
      const hooks = await gl.listProjectHooks(project);
      if (hooks.length === 0) {
        fail("该项目没有配置任何 webhook —— 创建 MR 不会自动审查，@ai 不会响应",
          `一条命令注册：mergelens hook install ${project} --url http://<部署机>:3000/webhook`);
      } else {
        for (const h of hooks) {
          const mrOk = h.merge_requests_events;
          const noteOk = h.note_events;
          console.log(`  ${mrOk && noteOk ? "✓" : "✗"} ${h.url}`);
          console.log(`      Merge request events: ${mrOk ? "✓" : "✗ 未勾选 → 创建 MR 不触发审查"}`);
          console.log(`      Comments: ${noteOk ? "✓" : "✗ 未勾选 → @ai 不会响应"}`);
          if (!mrOk || !noteOk) {
            allOk = false;
            console.log(`      修复：mergelens hook install ${project} --url ${h.url}（会补全事件勾选）`);
          }
        }
        console.log(`      提示：webhook 通不通还取决于 GitLab 服务器能否访问上述 URL——`);
        console.log(`      在 GitLab 那台机器上 curl <URL 前缀>/health 验证，并保持 mergelens start 常驻运行`);
      }
    } catch (err) {
      fail(`webhook 配置读取失败：${(err as Error).message}`,
        "查看项目 webhook 需要 Maintainer 权限的 token");
    }
  }

  console.log("\n" + (allOk
    ? "全部通过。下一步：npx tsx src/cli.ts review <project> <mr-iid> --dry-run"
    : "存在问题，按上面的提示逐项修复后重跑 doctor。"));
  return allOk;
}

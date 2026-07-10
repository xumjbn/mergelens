import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import type { Config } from "./types.js";
import { fileConfigToYaml, loadConfig, requireAiKey, requireToken, serverConfigPath } from "./config.js";
import { GitLab } from "./gitlab.js";
import { reviewMr, testSkillOnMr } from "./review/pipeline.js";
import { listBuiltinFiles, parseSkill, skillsRoot, REPO_SKILLS_DIR } from "./skills.js";
import { join } from "node:path";
import { readFeedback, readMemory, readReviews } from "./store.js";
import { riskyFiles } from "./memory.js";
import { renderConfigPage, renderDashboard, renderLogsPage, renderSkillsPage } from "./web.js";
import { answerMention, stripMention } from "./assistant.js";
import { collectFeedback } from "./feedback.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => res(b));
  });
}

function json(res: ServerResponse, code: number, data: unknown): void {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

/** 配置写操作的口令保护：设置了 ADMIN_TOKEN 才校验（支持 header 或 ?token= 查询参数，后者供浏览器页面使用）。 */
function adminOk(req: IncomingMessage): boolean {
  const t = process.env.ADMIN_TOKEN;
  if (!t) return true;
  if (req.headers["x-admin-token"] === t) return true;
  try {
    return new URL(req.url ?? "", "http://x").searchParams.get("token") === t;
  } catch {
    return false;
  }
}

/**
 * Webhook server.
 * GitLab → Settings → Webhooks → URL http://host:3000/webhook
 * 勾选 Merge request events，Secret token 填 WEBHOOK_SECRET。
 */
export function startServer(cfg: Config, port: number): void {
  // serialize reviews per MR so a rapid push burst doesn't double-review
  const running = new Set<string>();
  const queue: Array<{ project: string | number; iid: number; attempts?: number }> = [];
  const MAX_ATTEMPTS = 3;
  // 最近 30 条 webhook 事件及处理决定，暴露在 /health 里方便排查「为什么没触发」
  const recentEvents: Array<{ ts: string; kind: string; action?: string; project?: string; decision: string }> = [];
  const track = (e: (typeof recentEvents)[number]): void => {
    recentEvents.push(e);
    if (recentEvents.length > 30) recentEvents.shift();
    console.error(`[webhook] ${e.kind}${e.action ? "/" + e.action : ""} ${e.project ?? ""} → ${e.decision}`);
  };
  // 进程日志环形缓冲（/logs 页数据源）：拦截 console.error，保留最近 500 行
  const logBuf: string[] = [];
  const origErr = console.error.bind(console);
  console.error = (...args: unknown[]): void => {
    const line = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
    logBuf.push(`${new Date().toISOString().slice(5, 19).replace("T", " ")} ${line}`);
    if (logBuf.length > 500) logBuf.shift();
    origErr(...args);
  };

  // bot 自己的用户名（@提及检测、过滤自己发的评论），首次用到时拉取
  let botUser: string | null = null;
  const getBotUser = async (): Promise<string> =>
    (botUser ??= (await new GitLab(cfg).getCurrentUser()).username);
  const gl2 = (): GitLab => new GitLab(cfg);

  // 不同 MR 并行（上限 CONCURRENCY），同一 MR 严格串行（留在队列里等 key 释放）
  const CONCURRENCY = 3;
  function drain(): void {
    while (running.size < CONCURRENCY) {
      const idx = queue.findIndex((j) => !running.has(`${j.project}!${j.iid}`));
      if (idx === -1) break;
      const job = queue.splice(idx, 1)[0];
      const key = `${job.project}!${job.iid}`;
      running.add(key);
      void (async () => {
        try {
          await reviewMr(cfg, job.project, job.iid);
        } catch (err) {
          const attempts = (job.attempts ?? 0) + 1;
          if (attempts < MAX_ATTEMPTS) {
            const delayS = attempts * 60; // 60s / 120s 退避重试
            console.error(`[webhook] 审查 ${key} 失败（第 ${attempts} 次）：${(err as Error).message}，${delayS}s 后重试`);
            setTimeout(() => {
              queue.push({ ...job, attempts });
              drain();
            }, delayS * 1000).unref();
          } else {
            console.error(`[webhook] 审查 ${key} 连续 ${MAX_ATTEMPTS} 次失败，放弃：${(err as Error).message}`);
          }
        } finally {
          running.delete(key);
          drain();
        }
      })();
    }
  }

  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?") || req.url === "/dashboard")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      const q = new URL(req.url!, "http://x").searchParams;
      const selected = q.get("project") ?? "";
      const rangeDays = Math.min(365, Math.max(7, parseInt(q.get("days") ?? "14", 10) || 14));
      let reviews = readReviews();
      let feedback = readFeedback();
      const projects = [...new Set(reviews.map((r) => r.project))].sort();
      if (selected) {
        reviews = reviews.filter((r) => r.project === selected);
        feedback = feedback.filter((r) => r.project === selected);
      }
      const mem = readMemory();
      const memSel = selected ? mem.filter((m) => m.project === selected) : mem;
      const risky = (selected ? [selected] : [...new Set(mem.map((m) => m.project))])
        .flatMap((p) => riskyFiles(mem, p, 2, 8).map((f) => ({ ...f, project: p })))
        .sort((a, b) => b.critical - a.critical || b.total - a.total)
        .slice(0, 8);
      return void res.end(renderDashboard(reviews, feedback, cfg, risky, projects, selected, rangeDays, memSel));
    }
    if (req.method === "GET" && req.url?.split("?")[0] === "/logs") {
      if (process.env.ADMIN_TOKEN && !adminOk(req)) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        return void res.end("需要口令：/logs?token=<ADMIN_TOKEN>");
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(renderLogsPage(logBuf, recentEvents));
    }
    if (req.method === "GET" && req.url === "/config") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(renderConfigPage(cfg));
    }
    if (req.method === "GET" && req.url === "/skills") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(renderSkillsPage(listBuiltinFiles(cfg.review.skillsDir)));
    }
    if (req.method === "POST" && req.url === "/api/skills/builtin") {
      if (!adminOk(req)) return void json(res, 401, { error: "管理口令错误（ADMIN_TOKEN）" });
      return void readBody(req).then((body) => {
        try {
          const { file, content } = JSON.parse(body);
          if (!/^[\w-]+\.md$/.test(file)) throw new Error("文件名只能是 字母数字-下划线.md");
          const root = skillsRoot(cfg.review.skillsDir);
          if (!root) throw new Error("找不到内置 skill 目录");
          writeFileSync(join(root, file), content, "utf8");
          console.error(`[skills] 内置规则已更新：${join(root, file)}`);
          json(res, 200, { ok: true, path: join(root, file) });
        } catch (err) {
          json(res, 400, { error: (err as Error).message });
        }
      });
    }
    if (req.method === "GET" && req.url?.startsWith("/api/skills?")) {
      if (process.env.ADMIN_TOKEN && !adminOk(req)) return void json(res, 401, { error: "需要 x-admin-token" });
      const project = new URL(req.url, "http://x").searchParams.get("project") ?? "";
      return void (async () => {
        try {
          const gl = new GitLab(cfg);
          const info = await gl.getProject(project);
          const entries = await gl.listTree(project, REPO_SKILLS_DIR, info.default_branch);
          const repo = [];
          for (const e of entries.filter((x) => x.type === "blob" && x.name.endsWith(".md"))) {
            const raw = await gl.getRawFile(project, e.path, info.default_branch);
            const s = parseSkill(e.name, raw);
            repo.push({ name: s.name, triggers: s.triggers, file: e.name, raw });
          }
          json(res, 200, { repo, branch: info.default_branch });
        } catch (err) {
          json(res, 400, { error: (err as Error).message });
        }
      })();
    }
    if (req.method === "POST" && req.url === "/api/skills/commit") {
      if (!adminOk(req)) return void json(res, 401, { error: "管理口令错误（ADMIN_TOKEN）" });
      return void readBody(req).then(async (body) => {
        try {
          const { project, file, content } = JSON.parse(body);
          if (!/^[\w-]+\.md$/.test(file)) throw new Error("文件名只能是 字母数字-下划线.md");
          const info = await gl2().getProject(project);
          await gl2().commitFile(
            project, info.default_branch, `${REPO_SKILLS_DIR}/${file}`, content,
            `chore: 更新审查规则 ${file}（来自 mergelens Skill 页）`,
          );
          console.error(`[skills] 已提交 ${file} 到 ${project}@${info.default_branch}`);
          json(res, 200, { ok: true, branch: info.default_branch });
        } catch (err) {
          json(res, 400, { error: (err as Error).message });
        }
      });
    }
    if (req.method === "POST" && req.url === "/api/skills/test") {
      if (!adminOk(req)) return void json(res, 401, { error: "管理口令错误（ADMIN_TOKEN）" });
      return void readBody(req).then(async (body) => {
        try {
          const { project, iid, file, content } = JSON.parse(body);
          const skill = parseSkill(file ?? "test.md", content);
          console.error(`[skills] 回放 ${skill.name} @ ${project}!${iid}`);
          const result = await testSkillOnMr(cfg, project, iid, skill);
          json(res, 200, result);
        } catch (err) {
          json(res, 400, { error: (err as Error).message });
        }
      });
    }
    if (req.method === "POST" && req.url === "/api/config") {
      if (!adminOk(req)) return void json(res, 401, { error: "管理口令错误（ADMIN_TOKEN）" });
      return void readBody(req).then((body) => {
        try {
          const { config } = JSON.parse(body);
          const path = serverConfigPath();
          writeFileSync(path, fileConfigToYaml(config), "utf8");
          cfg = loadConfig(); // 热生效：后续审查用新配置
          console.error(`[config] 服务端配置已更新：${path}`);
          json(res, 200, { ok: true, path });
        } catch (err) {
          json(res, 400, { error: (err as Error).message });
        }
      });
    }
    if (req.method === "POST" && req.url === "/api/config/commit") {
      if (!adminOk(req)) return void json(res, 401, { error: "管理口令错误（ADMIN_TOKEN）" });
      return void readBody(req).then(async (body) => {
        try {
          const { project, config } = JSON.parse(body);
          const gl = new GitLab(cfg);
          const info = await gl.getProject(project);
          await gl.commitFile(
            project, info.default_branch, ".ai-review.yml",
            fileConfigToYaml(config),
            "chore: 更新 mergelens 审查配置（来自配置页）",
          );
          console.error(`[config] 已提交配置到 ${info.path_with_namespace}@${info.default_branch}`);
          json(res, 200, { ok: true, branch: info.default_branch });
        } catch (err) {
          json(res, 400, { error: (err as Error).message });
        }
      });
    }
    if (req.method === "GET" && req.url === "/api/reviews") {
      // 审查记录含发现标题（可能带代码语义）——设置了 ADMIN_TOKEN 时要求口令
      if (process.env.ADMIN_TOKEN && !adminOk(req)) return void json(res, 401, { error: "需要 x-admin-token" });
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      return void res.end(JSON.stringify(readReviews()));
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({
        ok: true, running: [...running], queued: queue.length, recentEvents,
      }, null, 2));
    }
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404);
      return void res.end();
    }
    if (cfg.webhookSecret && req.headers["x-gitlab-token"] !== cfg.webhookSecret) {
      track({ ts: new Date().toISOString(), kind: "(未知)", decision: "拒绝：Secret token 不匹配（GitLab webhook 设置里的 Secret 与 WEBHOOK_SECRET 环境变量不一致）" });
      res.writeHead(401);
      return void res.end("bad token");
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200);
      res.end("ok"); // respond fast; review runs async
      const ts = new Date().toISOString();
      try {
        const event = JSON.parse(body);
        const kind = event.object_kind ?? "(无 object_kind)";
        const projectPath = event.project?.path_with_namespace ?? String(event.project?.id ?? "?");

        // 评论事件：@机器人 对话
        if (kind === "note") {
          const attrs = event.object_attributes ?? {};
          const mrIid = event.merge_request?.iid;
          if (attrs.noteable_type !== "MergeRequest" || !mrIid) {
            track({ ts, kind, project: projectPath, decision: "忽略：非 MR 下的评论" });
            return;
          }
          void (async () => {
            try {
              let bot = "";
              try {
                bot = await getBotUser();
              } catch (err) {
                console.error("[assistant] 获取 bot 用户名失败（触发词仍可用）：" + (err as Error).message);
              }
              const author = event.user?.username ?? "";
              if (bot && author === bot) return; // 自己发的评论，静默跳过
              const note = String(attrs.note ?? "");
              const trigger = cfg.assistant.trigger;
              const hit =
                (bot && note.includes(`@${bot}`)) ||
                (trigger && note.toLowerCase().includes(trigger.toLowerCase()));
              if (!hit) {
                track({ ts, kind, project: `${projectPath}!${mrIid}`, decision: `忽略：评论不含触发词 ${trigger}${bot ? ` 或 @${bot}` : ""}` });
                return;
              }
              track({ ts, kind, project: `${projectPath}!${mrIid}`, decision: `回复 @${author} 的提问` });
              // 统一用路径做项目标识（与 CLI 一致，记忆库/统计不分裂成两个键）
              await answerMention(cfg, event.project?.path_with_namespace ?? event.project.id, mrIid, {
                question: stripMention(note, [bot ? `@${bot}` : "", trigger]),
                author,
                discussionId: attrs.discussion_id ?? undefined,
              });
              track({ ts: new Date().toISOString(), kind, project: `${projectPath}!${mrIid}`, decision: "✓ 已回复" });
            } catch (err) {
              // 失败原因进 recentEvents，光看 /health 就能定位
              track({
                ts: new Date().toISOString(), kind, project: `${projectPath}!${mrIid}`,
                decision: `回复失败：${(err as Error).message.slice(0, 180)}`,
              });
            }
          })();
          return;
        }

        if (kind !== "merge_request") {
          track({ ts, kind, project: projectPath, decision: "忽略：只处理 Merge request / Comments 事件（检查 webhook 勾选）" });
          return;
        }
        const attrs = event.object_attributes ?? {};
        const action = attrs.action as string;

        // MR 合并：结算采纳反馈（resolve/👍/👎）
        if (action === "merge") {
          track({ ts, kind, action, project: `${projectPath}!${attrs.iid}`, decision: "MR 已合并，结算采纳反馈" });
          void collectFeedback(cfg, event.project?.path_with_namespace ?? event.project.id, attrs.iid)
            .catch((err) => console.error("[feedback] 结算失败：" + (err as Error).message));
          return;
        }

        const isCodeUpdate = action === "update" && attrs.oldrev;
        if (action !== "open" && action !== "reopen" && !isCodeUpdate) {
          track({ ts, kind, action, project: projectPath, decision: `忽略：action=${action} 不触发审查（只响应 open/reopen/push 新提交/merge）` });
          return;
        }
        const project = event.project?.path_with_namespace ?? event.project?.id;
        const iid = attrs.iid;
        if (!project || !iid) {
          track({ ts, kind, action, project: projectPath, decision: "忽略：事件缺少 project 或 iid" });
          return;
        }
        track({ ts, kind, action, project: `${projectPath}!${iid}`, decision: "入队审查" });
        queue.push({ project, iid });
        void drain();
      } catch (err) {
        track({ ts, kind: "(解析失败)", decision: (err as Error).message });
      }
    });
  });

  server.listen(port, () => {
    console.error(`mergelens 服务已启动：http://0.0.0.0:${port}/`);
    console.error(`  看板 /  ·  配置 /config  ·  Skills /skills  ·  日志 /logs  ·  Webhook /webhook  ·  健康检查 /health`);
    if (!process.env.ADMIN_TOKEN) {
      console.error(`  提示：未设置 ADMIN_TOKEN，配置页的保存操作不需要口令（内网可接受，公网请设置）`);
    }
  });
}

// direct entry: `tsx src/server.ts`（daemon start 也走这里）
if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  const { loadDotEnv } = await import("./env.js");
  loadDotEnv();
  const { setupProxyFromEnv } = await import("./net.js");
  setupProxyFromEnv();
  const cfg = loadConfig();
  requireToken(cfg);
  requireAiKey(cfg);
  startServer(cfg, parseInt(process.env.PORT ?? "3000", 10));
}

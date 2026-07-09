import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { writeFileSync } from "node:fs";
import type { Config } from "./types.js";
import { fileConfigToYaml, loadConfig, requireAiKey, requireToken, serverConfigPath } from "./config.js";
import { GitLab } from "./gitlab.js";
import { reviewMr } from "./review/pipeline.js";
import { readFeedback, readReviews } from "./store.js";
import { renderConfigPage, renderDashboard } from "./web.js";
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

/** 配置写操作的口令保护：设置了 ADMIN_TOKEN 才校验。 */
function adminOk(req: IncomingMessage): boolean {
  const t = process.env.ADMIN_TOKEN;
  return !t || req.headers["x-admin-token"] === t;
}

/**
 * Webhook server.
 * GitLab → Settings → Webhooks → URL http://host:3000/webhook
 * 勾选 Merge request events，Secret token 填 WEBHOOK_SECRET。
 */
export function startServer(cfg: Config, port: number): void {
  // serialize reviews per MR so a rapid push burst doesn't double-review
  const running = new Set<string>();
  const queue: Array<{ project: number; iid: number }> = [];
  // 最近 30 条 webhook 事件及处理决定，暴露在 /health 里方便排查「为什么没触发」
  const recentEvents: Array<{ ts: string; kind: string; action?: string; project?: string; decision: string }> = [];
  const track = (e: (typeof recentEvents)[number]): void => {
    recentEvents.push(e);
    if (recentEvents.length > 30) recentEvents.shift();
    console.error(`[webhook] ${e.kind}${e.action ? "/" + e.action : ""} ${e.project ?? ""} → ${e.decision}`);
  };
  // bot 自己的用户名（@提及检测、过滤自己发的评论），首次用到时拉取
  let botUser: string | null = null;
  const getBotUser = async (): Promise<string> =>
    (botUser ??= (await new GitLab(cfg).getCurrentUser()).username);

  async function drain(): Promise<void> {
    const job = queue.shift();
    if (!job) return;
    const key = `${job.project}!${job.iid}`;
    if (running.has(key)) return void drain();
    running.add(key);
    try {
      await reviewMr(cfg, job.project, job.iid);
    } catch (err) {
      console.error(`[webhook] 审查 ${key} 失败：${(err as Error).message}`);
    } finally {
      running.delete(key);
      void drain();
    }
  }

  const server = createServer((req, res) => {
    if (req.method === "GET" && (req.url === "/" || req.url === "/dashboard")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(renderDashboard(readReviews(), readFeedback(), cfg));
    }
    if (req.method === "GET" && req.url === "/config") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(renderConfigPage(cfg));
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
              await answerMention(cfg, event.project.id, mrIid, {
                question: stripMention(note, [bot ? `@${bot}` : "", trigger]),
                author,
                discussionId: attrs.discussion_id ?? undefined,
              });
            } catch (err) {
              console.error("[assistant] 回复失败：" + (err as Error).message);
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
          void collectFeedback(cfg, event.project.id, attrs.iid)
            .catch((err) => console.error("[feedback] 结算失败：" + (err as Error).message));
          return;
        }

        const isCodeUpdate = action === "update" && attrs.oldrev;
        if (action !== "open" && action !== "reopen" && !isCodeUpdate) {
          track({ ts, kind, action, project: projectPath, decision: `忽略：action=${action} 不触发审查（只响应 open/reopen/push 新提交/merge）` });
          return;
        }
        const project = event.project?.id;
        const iid = attrs.iid;
        if (!project || !iid) {
          track({ ts, kind, action, project: projectPath, decision: "忽略：事件缺少 project.id 或 iid" });
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
    console.error(`  看板 /  ·  配置页 /config  ·  Webhook /webhook  ·  健康检查 /health  ·  数据 /api/reviews`);
    if (!process.env.ADMIN_TOKEN) {
      console.error(`  提示：未设置 ADMIN_TOKEN，配置页的保存操作不需要口令（内网可接受，公网请设置）`);
    }
  });
}

// direct entry: `tsx src/server.ts`
if (process.argv[1] && /server\.(ts|js)$/.test(process.argv[1])) {
  const { setupProxyFromEnv } = await import("./net.js");
  setupProxyFromEnv();
  const cfg = loadConfig();
  requireToken(cfg);
  requireAiKey(cfg);
  startServer(cfg, parseInt(process.env.PORT ?? "3000", 10));
}

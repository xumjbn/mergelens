import { createServer } from "node:http";
import type { Config } from "./types.js";
import { loadConfig, requireAiKey, requireToken } from "./config.js";
import { reviewMr } from "./review/pipeline.js";
import { readReviews } from "./store.js";
import { renderDashboard } from "./web.js";

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
      return void res.end(renderDashboard(readReviews(), cfg));
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
        if (kind !== "merge_request") {
          track({ ts, kind, project: projectPath, decision: "忽略：只处理 Merge request events（检查 webhook 是否勾选了别的事件）" });
          return;
        }
        const attrs = event.object_attributes ?? {};
        const action = attrs.action as string;
        const isCodeUpdate = action === "update" && attrs.oldrev;
        if (action !== "open" && action !== "reopen" && !isCodeUpdate) {
          track({ ts, kind, action, project: projectPath, decision: `忽略：action=${action} 不触发审查（只响应 open/reopen/push 新提交）` });
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
    console.error(`  看板 /  ·  Webhook /webhook  ·  健康检查 /health  ·  数据 /api/reviews`);
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

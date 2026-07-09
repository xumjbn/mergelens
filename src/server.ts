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
      return void res.end(JSON.stringify({ ok: true, running: [...running], queued: queue.length }));
    }
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404);
      return void res.end();
    }
    if (cfg.webhookSecret && req.headers["x-gitlab-token"] !== cfg.webhookSecret) {
      res.writeHead(401);
      return void res.end("bad token");
    }

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200);
      res.end("ok"); // respond fast; review runs async
      try {
        const event = JSON.parse(body);
        if (event.object_kind !== "merge_request") return;
        const attrs = event.object_attributes ?? {};
        const action = attrs.action as string;
        // open / reopen / update-with-new-commits trigger a review
        const isCodeUpdate = action === "update" && attrs.oldrev;
        if (action !== "open" && action !== "reopen" && !isCodeUpdate) return;
        const project = event.project?.id;
        const iid = attrs.iid;
        if (!project || !iid) return;
        console.error(`[webhook] ${event.project.path_with_namespace}!${iid} (${action}) 入队`);
        queue.push({ project, iid });
        void drain();
      } catch (err) {
        console.error("[webhook] 解析失败：" + (err as Error).message);
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

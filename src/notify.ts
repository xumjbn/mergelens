import { createHmac } from "node:crypto";
import type { Config, MrInfo, Severity } from "./types.js";

/**
 * 审查完成后推送到 IM。渠道通过环境变量启用（URL 含密钥，不进 yaml）：
 *   DINGTALK_WEBHOOK  钉钉群自定义机器人 webhook（含 access_token）
 *   DINGTALK_SECRET   机器人「加签」密钥（可选，安全设置选了加签才需要）
 *   WECOM_WEBHOOK     企业微信群机器人 webhook
 * 触发时机由 .ai-review.yml 的 notify.on 控制：all / needs-work（默认）/ off
 */

export interface NotifyPayload {
  project: string;
  mr: MrInfo;
  verdict: "approve" | "needs-work";
  counts: Record<Severity, number>;
  incremental: boolean;
}

/** 钉钉加签：timestamp\nsecret 做 HmacSHA256 → base64 → urlEncode */
export function dingtalkSign(secret: string, timestamp: number): string {
  const h = createHmac("sha256", secret).update(`${timestamp}\n${secret}`).digest("base64");
  return encodeURIComponent(h);
}

export function buildMarkdown(p: NotifyPayload): { title: string; text: string } {
  const icon = p.verdict === "needs-work" ? "⛔" : "✅";
  const verdictText = p.verdict === "needs-work" ? "建议修复后合并" : "未发现阻塞问题";
  const title = `${icon} AI 审查：${p.project}!${p.mr.iid}`;
  const text = [
    `### ${icon} mergelens 审查完成${p.incremental ? "（增量）" : ""}`,
    "",
    `**${p.mr.title}**`,
    "",
    `- 项目：${p.project}（\`${p.mr.source_branch}\` → \`${p.mr.target_branch}\`）`,
    `- 作者：@${p.mr.author.username}`,
    `- 结论：**${verdictText}**`,
    `- 发现：🔴 ${p.counts.critical} 高危 · 🟠 ${p.counts.serious} 严重 · 🟡 ${p.counts.suggestion} 建议`,
    "",
    `[查看 MR 与审查评论](${p.mr.web_url})`,
  ].join("\n");
  return { title, text };
}

async function post(url: string, body: unknown, channel: string): Promise<void> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data: any = await res.json().catch(() => ({}));
    // 钉钉/企微都在 200 里用 errcode 表达失败
    if (!res.ok || (data.errcode !== undefined && data.errcode !== 0)) {
      throw new Error(`${res.status} ${JSON.stringify(data).slice(0, 200)}`);
    }
    console.error(`[notify] ${channel} 推送成功`);
  } catch (err) {
    console.error(`[notify] ${channel} 推送失败：${(err as Error).message}`);
  }
}

/** 推送到所有已配置渠道。任何渠道失败只记日志，不影响审查主流程。 */
export async function notifyReview(cfg: Config, p: NotifyPayload): Promise<void> {
  const on = cfg.notify.on;
  if (on === "off") return;
  if (on === "needs-work" && p.verdict !== "needs-work") return;

  const tasks: Promise<void>[] = [];
  const { title, text } = buildMarkdown(p);

  const ding = process.env.DINGTALK_WEBHOOK;
  if (ding) {
    let url = ding;
    const secret = process.env.DINGTALK_SECRET;
    if (secret) {
      const ts = Date.now();
      url += `&timestamp=${ts}&sign=${dingtalkSign(secret, ts)}`;
    }
    // 机器人「自定义关键词」安全模式：消息必须包含关键词，否则 310000 关键词不匹配
    const kw = (cfg.notify.dingtalkKeyword ?? "").trim() || process.env.DINGTALK_KEYWORD || "";
    const dTitle = kw && !title.includes(kw) ? `${kw} ${title}` : title;
    const dText = kw && !text.includes(kw) ? `${kw}\n\n${text}` : text;
    tasks.push(post(url, { msgtype: "markdown", markdown: { title: dTitle, text: dText } }, "钉钉"));
  }

  const wecom = process.env.WECOM_WEBHOOK;
  if (wecom) {
    tasks.push(post(wecom, { msgtype: "markdown", markdown: { content: text } }, "企业微信"));
  }

  if (tasks.length === 0) {
    console.error("[notify] notify.on 已开启但未配置任何渠道（DINGTALK_WEBHOOK / WECOM_WEBHOOK）");
  }
  await Promise.all(tasks);
}

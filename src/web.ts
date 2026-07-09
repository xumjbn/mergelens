import type { Config } from "./types.js";
import type { ReviewRecord } from "./store.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 服务端渲染的看板首页：指标、14 天趋势、最近审查列表。 */
export function renderDashboard(records: ReviewRecord[], cfg: Config): string {
  const total = records.length;
  const week = records.filter((r) => Date.now() - Date.parse(r.ts) < 7 * 86400_000);
  const sum = (f: (r: ReviewRecord) => number) => records.reduce((s, r) => s + f(r), 0);
  const critical = sum((r) => r.critical);
  const serious = sum((r) => r.serious);
  const suggestion = sum((r) => r.suggestion);
  const needsWork = records.filter((r) => r.verdict === "needs-work").length;
  const blockRate = total > 0 ? Math.round((needsWork / total) * 100) : 0;

  // 最近 14 天每日审查数
  const days: { label: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000);
    const key = d.toISOString().slice(0, 10);
    days.push({
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      count: records.filter((r) => r.ts.slice(0, 10) === key).length,
    });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.count));
  const bars = days.map((d, i) => {
    const h = Math.round((d.count / maxDay) * 96);
    const x = i * 44;
    return `<g>
      <rect x="${x + 6}" y="${110 - h}" width="32" height="${h}" rx="4" fill="var(--accent)" opacity="${d.count ? 0.85 : 0.15}"${d.count ? "" : ' height="4" y="106"'}></rect>
      ${d.count ? `<text x="${x + 22}" y="${102 - h}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--ink)">${d.count}</text>` : ""}
      <text x="${x + 22}" y="126" text-anchor="middle" font-size="10" fill="var(--ink3)">${d.label}</text>
    </g>`;
  }).join("");

  const rows = records.slice(-20).reverse().map((r) => {
    const flag = r.verdict === "needs-work"
      ? '<span class="badge bad">⛔ 建议修复</span>'
      : '<span class="badge ok">✅ 通过</span>';
    const tags = [r.incremental ? "增量" : "", r.dryRun ? "dry-run" : ""].filter(Boolean)
      .map((t) => `<span class="chip">${t}</span>`).join(" ");
    return `<tr>
      <td class="mono">${esc(r.ts.slice(5, 16).replace("T", " "))}</td>
      <td class="mono">${esc(r.project)}!${r.iid}</td>
      <td>${esc(r.title.slice(0, 48))}${r.title.length > 48 ? "…" : ""}</td>
      <td>${flag}</td>
      <td class="mono">🔴${r.critical} 🟠${r.serious} 🟡${r.suggestion}</td>
      <td>${tags}</td>
      <td class="mono dim">${(r.durationMs / 1000).toFixed(0)}s</td>
    </tr>`;
  }).join("") || `<tr><td colspan="7" class="dim" style="text-align:center;padding:28px">还没有审查记录 —— 跑一次 review 后刷新</td></tr>`;

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>mergelens · 审查看板</title>
<style>
:root{--page:#F4F6F5;--surface:#fff;--ink:#17241F;--ink2:#55655E;--ink3:#8A968F;
  --line:#E3E8E5;--accent:#0E7A6E;--good:#0B7C3E;--bad:#C13333;
  --good-bg:rgba(11,124,62,.1);--bad-bg:rgba(193,51,51,.1)}
@media(prefers-color-scheme:dark){:root{--page:#0E1412;--surface:#161D1A;--ink:#E7EDEA;
  --ink2:#A3B0A9;--ink3:#71807A;--line:#26302B;--accent:#3FBFAE;--good:#3FAE6A;--bad:#E06060;
  --good-bg:rgba(63,174,106,.14);--bad-bg:rgba(224,96,96,.13)}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);
  font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:18px;margin:0}h1 b{color:var(--accent)}
.sub{color:var(--ink3);font-size:12px;margin:2px 0 22px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-bottom:14px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px 18px}
.k{font-size:12px;color:var(--ink2)}.v{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.v small{font-size:13px;color:var(--ink3);font-weight:500}
.cfg{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.chip{display:inline-block;font-size:11px;padding:2px 9px;border-radius:999px;
  background:var(--surface);border:1px solid var(--line);color:var(--ink2)}
.mono{font-family:Consolas,monospace;font-size:12px}.dim{color:var(--ink3)}
table{width:100%;border-collapse:collapse;font-size:13px}
th{font-size:11px;color:var(--ink3);text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
tr:last-child td{border-bottom:none}
.badge{font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px;white-space:nowrap}
.badge.ok{color:var(--good);background:var(--good-bg)}.badge.bad{color:var(--bad);background:var(--bad-bg)}
.grid{display:grid;grid-template-columns:1fr;gap:14px}
.card h3{font-size:13px;margin:0 0 10px}
svg{display:block;width:100%;height:auto}
</style></head><body><div class="wrap">
<h1>merge<b>lens</b> · 审查看板</h1>
<div class="sub">数据每 60s 自动刷新 · JSON API：<span class="mono">/api/reviews</span> · 健康检查：<span class="mono">/health</span></div>

<div class="tiles">
  <div class="card"><div class="k">累计审查</div><div class="v">${total}<small> 次（近7天 ${week.length}）</small></div></div>
  <div class="card"><div class="k">发现问题</div><div class="v">${critical + serious + suggestion}<small> 🔴${critical} 🟠${serious} 🟡${suggestion}</small></div></div>
  <div class="card"><div class="k">门禁拦截率</div><div class="v">${blockRate}<small>%（${needsWork} 次建议修复）</small></div></div>
  <div class="card"><div class="k">低置信度自动过滤</div><div class="v">${sum((r) => r.filtered)}<small> 条（降噪）</small></div></div>
</div>

<div class="cfg">
  <span class="chip">模型 ${esc(cfg.ai.provider)}/${esc(cfg.ai.model)}</span>
  <span class="chip">门禁 ${esc(String(cfg.review.severityGate))}</span>
  <span class="chip">增量审查 ${cfg.review.incremental ? "开" : "关"}</span>
  <span class="chip">反驳验证 ${cfg.review.verify ? "开" : "关"}</span>
  <span class="chip">推送 ${esc(cfg.notify.on)}${process.env.DINGTALK_WEBHOOK ? " · 钉钉✓" : ""}${process.env.WECOM_WEBHOOK ? " · 企微✓" : ""}</span>
</div>

<div class="grid">
  <div class="card"><h3>最近 14 天审查量</h3>
    <svg viewBox="0 0 616 132" role="img" aria-label="最近14天每日审查量柱状图">${bars}</svg>
  </div>
  <div class="card" style="padding:6px 0 0">
    <h3 style="padding:10px 18px 0">最近审查</h3>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>时间</th><th>MR</th><th>标题</th><th>结论</th><th>发现</th><th></th><th>耗时</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>
</div>
</div></body></html>`;
}

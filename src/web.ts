import type { Config, Skill } from "./types.js";
import type { FeedbackRecord, MemoryRecord, ReviewRecord } from "./store.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 服务端渲染的看板首页：指标、14 天趋势、高风险文件、最近审查列表。 */
export function renderDashboard(
  records: ReviewRecord[],
  feedback: FeedbackRecord[],
  cfg: Config,
  risky: Array<{ file: string; total: number; critical: number; project?: string }> = [],
  projects: string[] = [],
  selected = "",
  rangeDays = 14,
  memory: MemoryRecord[] = [],
): string {
  const fSum = (f: (r: FeedbackRecord) => number) => feedback.reduce((s, r) => s + f(r), 0);
  const fbFindings = fSum((r) => r.findings);
  const fbResolved = fSum((r) => r.resolved);
  const adoption = fbFindings > 0 ? Math.round((fbResolved / fbFindings) * 100) : null;
  const total = records.length;
  const week = records.filter((r) => Date.now() - Date.parse(r.ts) < 7 * 86400_000);
  const sum = (f: (r: ReviewRecord) => number) => records.reduce((s, r) => s + f(r), 0);
  const critical = sum((r) => r.critical);
  const serious = sum((r) => r.serious);
  const suggestion = sum((r) => r.suggestion);
  const needsWork = records.filter((r) => r.verdict === "needs-work").length;
  const blockRate = total > 0 ? Math.round((needsWork / total) * 100) : 0;

  // 时间分桶：≤31 天按日，更长按周（保持柱数可读）
  const daily = rangeDays <= 31;
  const unitMs = (daily ? 1 : 7) * 86400_000;
  const nBuckets = daily ? rangeDays : Math.ceil(rangeDays / 7);
  const buckets: { label: string; from: number; to: number }[] = [];
  for (let i = nBuckets - 1; i >= 0; i--) {
    const to = Date.now() - i * unitMs;
    const d = new Date(to);
    buckets.push({
      label: `${d.getMonth() + 1}/${d.getDate()}`,
      from: to - unitMs,
      to,
    });
  }
  const inBucket = (ts: string, b: { from: number; to: number }): boolean => {
    const t = Date.parse(ts);
    return t > b.from && t <= b.to;
  };
  // 通用柱状图：自适应柱宽 + 零值短桩 + 稀疏刻度
  const barChart = (values: number[], fmt: (v: number) => string): string => {
    const W = 616;
    const slot = W / nBuckets;
    const bw = Math.max(8, Math.min(34, slot - 8));
    const maxV = Math.max(1, ...values);
    const labelEvery = Math.ceil(nBuckets / 12);
    return values.map((v, i) => {
      const h = v > 0 ? Math.max(6, Math.round((v / maxV) * 96)) : 4;
      const cx = i * slot + slot / 2;
      return `<g>
        <rect x="${(cx - bw / 2).toFixed(1)}" y="${110 - h}" width="${bw.toFixed(1)}" height="${h}" rx="3" fill="var(--accent)" opacity="${v ? 0.85 : 0.18}"></rect>
        ${v && nBuckets <= 16 ? `<text x="${cx.toFixed(1)}" y="${102 - h}" text-anchor="middle" font-size="11" font-weight="700" fill="var(--ink)">${fmt(v)}</text>` : ""}
        ${i % labelEvery === 0 || i === nBuckets - 1 ? `<text x="${cx.toFixed(1)}" y="126" text-anchor="middle" font-size="10" fill="var(--ink3)">${buckets[i].label}</text>` : ""}
      </g>`;
    }).join("");
  };
  const reviewCounts = buckets.map((b) => records.filter((r) => inBucket(r.ts, b)).length);
  const tokenSums = buckets.map((b) =>
    records.filter((r) => inBucket(r.ts, b)).reduce((s, r) => s + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0));
  const bars = barChart(reviewCounts, String);
  const tokenBars = barChart(tokenSums, (v) => (v / 10000).toFixed(1));
  const hasTokens = tokenSums.some((v) => v > 0);

  // 按项目分布（全部项目视图才显示）
  const byProject = [...new Set(records.map((r) => r.project))]
    .map((p) => {
      const rs = records.filter((r) => r.project === p);
      return { p, n: rs.length, findings: rs.reduce((s, r) => s + r.critical + r.serious + r.suggestion, 0) };
    })
    .sort((a, b) => b.n - a.n).slice(0, 8);
  const maxProjN = Math.max(1, ...byProject.map((x) => x.n));

  // 发现按审查维度（skill）分布，取时间范围内的记忆库记录
  const rangeFrom = Date.now() - rangeDays * 86400_000;
  const memInRange = memory.filter((m) => Date.parse(m.ts) >= rangeFrom);
  const bySkill = [...new Set(memInRange.map((m) => m.skill))]
    .map((s) => {
      const ms = memInRange.filter((m) => m.skill === s);
      return { s, n: ms.length, hi: ms.filter((m) => m.severity === "critical" || m.severity === "serious").length };
    })
    .sort((a, b) => b.n - a.n).slice(0, 10);
  const maxSkillN = Math.max(1, ...bySkill.map((x) => x.n));

  const hbar = (label: string, n: number, max: number, extra: string): string => `
    <div style="display:flex;align-items:center;gap:10px;padding:4px 0;font-size:12.5px">
      <span class="mono" style="width:150px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(label)}</span>
      <span style="flex:1;height:8px;background:var(--surface-2,rgba(128,128,128,.12));border-radius:4px;overflow:hidden">
        <span style="display:block;height:100%;width:${Math.round((n / max) * 100)}%;background:var(--accent);border-radius:4px"></span></span>
      <span class="mono" style="width:110px;text-align:right">${extra}</span>
    </div>`;

  const SEV_ICON: Record<string, string> = { critical: "🔴", serious: "🟠", suggestion: "🟡" };
  const rows = records.slice(-20).reverse().map((r, idx) => {
    const flag = r.verdict === "needs-work"
      ? '<span class="badge bad">⛔ 建议修复</span>'
      : '<span class="badge ok">✅ 通过</span>';
    const tags = [r.incremental ? "增量" : "", r.dryRun ? "dry-run" : ""].filter(Boolean)
      .map((t) => `<span class="chip">${t}</span>`).join(" ");
    const hasDetail = (r.details?.length ?? 0) > 0 || r.url;
    const detailBody = (r.details?.length ?? 0) > 0
      ? r.details!.map((d) => `<div class="dline">${SEV_ICON[d.severity] ?? "•"} <b>${esc(d.title)}</b>
          <span class="dim mono">${esc(d.file)}${d.line ? ":" + d.line : ""} · ${esc(d.skill)} · ${d.confidence}%</span></div>`).join("")
      : '<span class="dim">本次没有发现（或旧版本记录无详情快照）</span>';
    const link = r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">在 GitLab 打开 MR ↗</a>` : "";
    return `<tr class="${hasDetail ? "expandable" : ""}" ${hasDetail ? `onclick="toggleDetail(${idx})"` : ""}>
      <td class="mono">${esc(r.ts.slice(5, 16).replace("T", " "))}</td>
      <td class="mono">${esc(r.project)}!${r.iid}</td>
      <td>${esc(r.title.slice(0, 48))}${r.title.length > 48 ? "…" : ""}</td>
      <td>${flag}</td>
      <td class="mono">🔴${r.critical} 🟠${r.serious} 🟡${r.suggestion}</td>
      <td>${tags}</td>
      <td class="mono dim">${(r.durationMs / 1000).toFixed(0)}s ${hasDetail ? '<span class="dim">▾</span>' : ""}</td>
    </tr>
    ${hasDetail ? `<tr class="detail-row" id="detail-${idx}" style="display:none"><td colspan="7">
      <div class="detail-box">${detailBody}${link ? `<div style="margin-top:8px">${link}</div>` : ""}</div>
    </td></tr>` : ""}`;
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
tr.expandable{cursor:pointer}tr.expandable:hover td{background:rgba(14,122,110,.05)}
.detail-row td{padding:0 12px 12px;border-bottom:1px solid var(--line)}
.detail-box{background:var(--page);border-radius:8px;padding:10px 14px;font-size:12.5px}
.detail-box .dline{padding:3px 0}
.detail-box a{color:var(--accent);font-size:12px}
</style>
<script>
function toggleDetail(i){
  const el = document.getElementById('detail-' + i);
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}
</script></head><body><div class="wrap">
<h1>merge<b>lens</b> · 审查看板
  <a href="/config" style="font-size:13px;font-weight:400;color:var(--accent);margin-left:10px">⚙ 配置</a>
  <a href="/skills" style="font-size:13px;font-weight:400;color:var(--accent);margin-left:6px">🧩 Skills</a>
  <a href="/logs" style="font-size:13px;font-weight:400;color:var(--accent);margin-left:6px">📜 日志</a></h1>
<div class="sub">数据每 60s 自动刷新 · JSON API：<span class="mono">/api/reviews</span> · 健康检查：<span class="mono">/health</span></div>
<div style="margin:-8px 0 18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
  ${projects.length > 1 ? `<select class="mono" style="padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink)"
    onchange="location = (this.value ? '/?project=' + encodeURIComponent(this.value) + '&' : '/?') + 'days=${rangeDays}'">
    <option value="">全部项目（${projects.length}）</option>
    ${projects.map((p) => `<option value="${esc(p)}"${p === selected ? " selected" : ""}>${esc(p)}</option>`).join("")}
  </select>` : ""}
  ${[7, 14, 30, 90].map((d) => {
    const url = `/?${selected ? "project=" + encodeURIComponent(selected) + "&" : ""}days=${d}`;
    return `<a href="${url}" class="chip" style="text-decoration:none;${d === rangeDays ? "color:var(--good);font-weight:700;border-color:var(--good)" : ""}">${d} 天</a>`;
  }).join("")}
</div>

<div class="tiles">
  <div class="card"><div class="k">累计审查</div><div class="v">${total}<small> 次（近7天 ${week.length}）</small></div></div>
  <div class="card"><div class="k">发现问题</div><div class="v">${critical + serious + suggestion}<small> 🔴${critical} 🟠${serious} 🟡${suggestion}</small></div></div>
  <div class="card"><div class="k">门禁拦截率</div><div class="v">${blockRate}<small>%（${needsWork} 次建议修复）</small></div></div>
  <div class="card"><div class="k">建议采纳率</div><div class="v">${adoption === null ? "—" : adoption + '<small>%</small>'}<small> 👍${fSum((r) => r.up)} 👎${fSum((r) => r.down)} · 已结算 ${feedback.length} 个 MR</small></div></div>
  <div class="card"><div class="k">Token 消耗</div><div class="v">${(() => {
    const tok = records.reduce((s, r) => s + (r.tokensIn ?? 0) + (r.tokensOut ?? 0), 0);
    return tok > 0 ? (tok / 10000).toFixed(1) + '<small> 万</small>' : "—";
  })()}<small>${cfg.review.dailyTokenBudget > 0 ? ` 日预算 ${(cfg.review.dailyTokenBudget / 10000).toFixed(0)} 万` : " 未设预算"}</small></div></div>
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
  <div class="card"><h3>最近 ${rangeDays} 天审查量${daily ? "" : "（按周聚合）"}</h3>
    <svg viewBox="0 0 616 132" role="img" aria-label="审查量趋势柱状图">${bars}</svg>
  </div>
  ${hasTokens ? `<div class="card"><h3>Token 消耗趋势（柱上数字为万）</h3>
    <svg viewBox="0 0 616 132" role="img" aria-label="Token 消耗趋势柱状图">${tokenBars}</svg>
  </div>` : ""}
  ${!selected && byProject.length > 1 ? `<div class="card"><h3>按项目（审查次数 · 累计）</h3>
    ${byProject.map((x) => hbar(x.p, x.n, maxProjN, `${x.n} 次 · ${x.findings} 发现`)).join("")}
  </div>` : ""}
  ${bySkill.length > 0 ? `<div class="card"><h3>发现按审查维度（最近 ${rangeDays} 天${selected ? " · " + esc(selected) : ""}）</h3>
    ${bySkill.map((x) => hbar(x.s, x.n, maxSkillN, `${x.n} 条 · 高危严重 ${x.hi}`)).join("")}
  </div>` : ""}
  ${risky.length > 0 ? `<div class="card"><h3>高风险文件（历史发现聚集，审查时自动从严）</h3>
    <table><thead><tr><th>文件</th><th>项目</th><th>历史发现</th><th>高危/严重</th></tr></thead><tbody>
    ${risky.slice(0, 8).map((f) => `<tr><td class="mono">${esc(f.file)}</td><td class="mono dim">${esc(f.project ?? "")}</td><td class="mono">${f.total}</td><td class="mono" style="color:${f.critical > 0 ? "var(--bad)" : "inherit"}">${f.critical}</td></tr>`).join("")}
    </tbody></table></div>` : ""}
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

/** 配置页：编辑非密钥配置，保存到服务端 yaml 或提交到指定仓库。 */
export function renderConfigPage(cfg: Config): string {
  const env = (name: string): string =>
    process.env[name]
      ? `<span class="badge ok">✓ 已配置</span>`
      : `<span class="badge bad">未配置</span>`;
  const enabled = cfg.review.enabledSkills === "all" ? "all" : cfg.review.enabledSkills.join(", ");
  const sel = (v: string, cur: string): string => (v === cur ? " selected" : "");
  const chk = (b: boolean): string => (b ? " checked" : "");

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mergelens · 配置</title>
<style>
:root{--page:#F4F6F5;--surface:#fff;--ink:#17241F;--ink2:#55655E;--ink3:#8A968F;
  --line:#E3E8E5;--accent:#0E7A6E;--good:#0B7C3E;--bad:#C13333;
  --good-bg:rgba(11,124,62,.1);--bad-bg:rgba(193,51,51,.1)}
@media(prefers-color-scheme:dark){:root{--page:#0E1412;--surface:#161D1A;--ink:#E7EDEA;
  --ink2:#A3B0A9;--ink3:#71807A;--line:#26302B;--accent:#3FBFAE;--good:#3FAE6A;--bad:#E06060;
  --good-bg:rgba(63,174,106,.14);--bad-bg:rgba(224,96,96,.13)}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);
  font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:860px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:18px;margin:0}h1 b{color:var(--accent)}h1 a{color:var(--accent);font-size:13px;font-weight:400;margin-left:10px}
.sub{color:var(--ink3);font-size:12px;margin:2px 0 22px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:14px}
.card h3{font-size:13px;margin:0 0 14px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px 16px}
@media(max-width:640px){.grid2{grid-template-columns:1fr}}
label{display:block;font-size:12px;font-weight:600;margin-bottom:4px}
.hint{font-size:11px;color:var(--ink3);margin-top:3px}
input[type=text],input[type=number],select,textarea{width:100%;padding:7px 10px;border-radius:8px;
  border:1px solid var(--line);background:var(--surface);color:var(--ink);font:inherit;font-size:13px}
textarea{font-family:Consolas,monospace;font-size:12px}
.row{display:flex;align-items:center;gap:8px;font-size:13px}
.badge{font-size:11.5px;font-weight:600;padding:2px 9px;border-radius:999px}
.badge.ok{color:var(--good);background:var(--good-bg)}.badge.bad{color:var(--bad);background:var(--bad-bg)}
.envrow{display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}
.envrow:last-child{border-bottom:none}.mono{font-family:Consolas,monospace;font-size:12px}
button{padding:8px 16px;border-radius:8px;border:1px solid var(--line);background:var(--surface);
  color:var(--ink);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--page);
  padding:10px 18px;border-radius:9px;font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none}
#toast.on{opacity:1}
</style></head><body><div class="wrap">
<h1>merge<b>lens</b> · 配置 <a href="/">← 返回看板</a></h1>
<div class="sub">密钥类（token / API key / webhook 地址）只能通过环境变量配置，此页仅显示状态</div>

<div class="card"><h3>AI 模型</h3><div class="grid2">
  <div><label>Provider</label>
    <select id="ai_provider">
      <option${sel("anthropic", cfg.ai.provider)}>anthropic</option>
      <option${sel("openai", cfg.ai.provider)}>openai</option>
      <option${sel("deepseek", cfg.ai.provider)}>deepseek</option>
      <option${sel("ollama", cfg.ai.provider)}>ollama</option>
    </select></div>
  <div><label>主模型</label><input type="text" id="ai_model" value="${esc(cfg.ai.model)}"></div>
  <div><label>降级模型（可空）</label><input type="text" id="ai_fallback" value="${esc(cfg.ai.fallbackModel ?? "")}">
    <div class="hint">主模型失败时自动切换</div></div>
  <div><label>轻量模型（可空）</label><input type="text" id="ai_light" value="${esc(cfg.ai.lightModel ?? "")}">
    <div class="hint">反驳验证 / 摘要 / 判重等便宜任务</div></div>
  <div><label>temperature</label><input type="number" id="ai_temp" step="0.1" min="0" max="1" value="${cfg.ai.temperature}"></div>
  <div><label>max_tokens</label><input type="number" id="ai_maxtok" value="${cfg.ai.maxTokens}"></div>
</div></div>

<div class="card"><h3>审查行为</h3><div class="grid2">
  <div><label>严重度门禁</label>
    <select id="r_gate">
      <option value="suggestion"${sel("suggestion", String(cfg.review.severityGate))}>建议（最严）</option>
      <option value="serious"${sel("serious", String(cfg.review.severityGate))}>严重</option>
      <option value="critical"${sel("critical", String(cfg.review.severityGate))}>高危</option>
      <option value="off"${sel("off", String(cfg.review.severityGate))}>关闭门禁</option>
    </select>
    <div class="hint">达到该级别 → 总评判定「建议修复后合并」，CLI 退出码 1</div></div>
  <div><label>评论语言</label><input type="text" id="r_lang" value="${esc(cfg.review.language)}"></div>
  <div><label>单次 diff 上限（行）</label><input type="number" id="r_maxdiff" value="${cfg.review.maxDiffLines}"></div>
  <div><label>每 MR 最多行内评论</label><input type="number" id="r_maxcom" value="${cfg.review.maxComments}"></div>
  <div><label>最低置信度（0-100）</label><input type="number" id="r_minconf" value="${cfg.review.minConfidence}"></div>
  <div style="display:flex;flex-direction:column;gap:8px;justify-content:center">
    <label class="row" style="font-weight:400"><input type="checkbox" id="r_verify"${chk(cfg.review.verify)}> 反驳验证（降误报）</label>
    <label class="row" style="font-weight:400"><input type="checkbox" id="r_incr"${chk(cfg.review.incremental)}> 增量审查</label>
  </div>
  <div style="grid-column:1/-1"><label>忽略路径（每行一个 glob）</label>
    <textarea id="r_ignore" rows="4">${esc(cfg.review.ignorePaths.join("\n"))}</textarea></div>
</div></div>

<div class="card"><h3>Skills 与推送</h3><div class="grid2">
  <div><label>启用的 skill</label><input type="text" id="sk_enabled" value="${esc(enabled)}">
    <div class="hint">all 或逗号分隔：correctness, security</div></div>
  <div><label>推送时机</label>
    <select id="n_on">
      <option value="needs-work"${sel("needs-work", cfg.notify.on)}>needs-work（只推有阻塞问题的）</option>
      <option value="all"${sel("all", cfg.notify.on)}>all（每次都推）</option>
      <option value="off"${sel("off", cfg.notify.on)}>off（不推）</option>
    </select></div>
  <div><label>评论区触发词</label><input type="text" id="a_trigger" value="${esc(cfg.assistant.trigger)}">
    <div class="hint">评论包含它即唤起机器人（如 @ai）；真实 @bot用户名 也始终有效</div></div>
</div></div>

<div class="card"><h3>密钥与渠道（环境变量，只读）</h3>
  <div class="envrow"><span class="mono">GITLAB_TOKEN</span>${env("GITLAB_TOKEN")}</div>
  <div class="envrow"><span class="mono">ANTHROPIC / OPENAI / DEEPSEEK _API_KEY</span>${
    process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY
      ? '<span class="badge ok">✓ 已配置</span>' : '<span class="badge bad">未配置</span>'}</div>
  <div class="envrow"><span class="mono">WEBHOOK_SECRET</span>${env("WEBHOOK_SECRET")}</div>
  <div class="envrow"><span class="mono">DINGTALK_WEBHOOK（钉钉推送）</span>${env("DINGTALK_WEBHOOK")}</div>
  <div class="envrow"><span class="mono">WECOM_WEBHOOK（企业微信推送）</span>${env("WECOM_WEBHOOK")}</div>
  <div class="envrow"><span class="mono">ADMIN_TOKEN（本页写保护）</span>${env("ADMIN_TOKEN")}</div>
</div>

<div class="card"><h3>保存</h3>
  <div class="bar" style="margin-bottom:12px">
    <input type="text" id="admin_token" placeholder="管理口令（设置了 ADMIN_TOKEN 才需要）" style="max-width:280px">
  </div>
  <div class="bar">
    <button class="primary" onclick="saveServer()">保存为服务端默认</button>
    <span class="hint">写入服务端 .ai-review.yml，立即热生效，对所有未自带配置的项目生效</span>
  </div>
  <div class="bar" style="margin-top:12px">
    <input type="text" id="repo_target" placeholder="group/project" style="max-width:280px">
    <button onclick="commitRepo()">提交到指定仓库</button>
    <span class="hint">向该仓库默认分支提交 .ai-review.yml（项目级配置，覆盖服务端默认）</span>
  </div>
</div>
<div id="toast"></div>

<script>
const $ = id => document.getElementById(id);
$('admin_token').value = localStorage.getItem('mergelens_admin') || '';
function toast(m){ $('toast').textContent = m; $('toast').classList.add('on');
  clearTimeout(window.__t); window.__t = setTimeout(()=>$('toast').classList.remove('on'), 3000); }
function collect(){
  const v = id => $(id).value.trim();
  const n = id => v(id) === '' ? undefined : Number(v(id));
  const en = v('sk_enabled');
  return {
    ai: { provider: v('ai_provider'), model: v('ai_model'), fallback: v('ai_fallback') || undefined,
          light_model: v('ai_light') || undefined, temperature: n('ai_temp'), max_tokens: n('ai_maxtok') },
    review: { severity_gate: v('r_gate'), language: v('r_lang'), max_diff_lines: n('r_maxdiff'),
              max_comments: n('r_maxcom'), min_confidence: n('r_minconf'),
              verify: $('r_verify').checked, incremental: $('r_incr').checked,
              ignore_paths: $('r_ignore').value.split('\\n').map(s=>s.trim()).filter(Boolean) },
    skills: { enabled: en === 'all' ? 'all' : en.split(',').map(s=>s.trim()).filter(Boolean) },
    notify: { on: v('n_on') },
    assistant: { trigger: v('a_trigger') || '@ai' },
  };
}
async function post(url, body){
  localStorage.setItem('mergelens_admin', $('admin_token').value);
  const res = await fetch(url, { method:'POST',
    headers: { 'content-type':'application/json', 'x-admin-token': $('admin_token').value },
    body: JSON.stringify(body) });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || res.status);
  return data;
}
async function saveServer(){
  try { const r = await post('/api/config', { config: collect() }); toast('已保存并热生效：' + r.path); }
  catch(e){ toast('保存失败：' + e.message); }
}
async function commitRepo(){
  const p = $('repo_target').value.trim();
  if(!p) return toast('先填仓库路径，如 group/project');
  try { const r = await post('/api/config/commit', { project: p, config: collect() });
        toast('已提交到 ' + p + ' 的 ' + r.branch + ' 分支'); }
  catch(e){ toast('提交失败：' + e.message); }
}
</script>
</div></body></html>`;
}

/** 运行日志页：进程日志环形缓冲 + webhook 事件决策，10s 自动刷新。 */
export function renderLogsPage(
  logLines: string[],
  events: Array<{ ts: string; kind: string; action?: string; project?: string; decision: string }>,
): string {
  const evRows = events.slice().reverse().map((e) => `<tr>
    <td class="mono dim">${esc(e.ts.slice(5, 19).replace("T", " "))}</td>
    <td class="mono">${esc(e.kind)}${e.action ? "/" + esc(e.action) : ""}</td>
    <td class="mono">${esc(e.project ?? "")}</td>
    <td class="${e.decision.includes("失败") || e.decision.includes("拒绝") ? "bad" : e.decision.startsWith("✓") || e.decision.includes("入队") || e.decision.startsWith("回复") ? "good" : "dim"}">${esc(e.decision)}</td>
  </tr>`).join("") || `<tr><td colspan="4" class="dim">还没有收到任何 webhook 事件</td></tr>`;

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>mergelens · 运行日志</title>
<style>
:root{--page:#F4F6F5;--surface:#fff;--ink:#17241F;--ink3:#8A968F;--line:#E3E8E5;
  --accent:#0E7A6E;--good:#0B7C3E;--bad:#C13333}
@media(prefers-color-scheme:dark){:root{--page:#0E1412;--surface:#161D1A;--ink:#E7EDEA;
  --ink3:#71807A;--line:#26302B;--accent:#3FBFAE;--good:#3FAE6A;--bad:#E06060}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);
  font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:18px;margin:0}h1 b{color:var(--accent)}h1 a{color:var(--accent);font-size:13px;font-weight:400;margin-left:10px}
.sub{color:var(--ink3);font-size:12px;margin:2px 0 18px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin-bottom:14px}
.card h3{font-size:13px;margin:0 0 10px}
.mono{font-family:Consolas,monospace;font-size:12px}.dim{color:var(--ink3)}
.good{color:var(--good)}.bad{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:12.5px}
td{padding:5px 10px;border-bottom:1px solid var(--line);vertical-align:top}
pre{background:var(--page);border-radius:8px;padding:12px;overflow-x:auto;
  font-size:11.5px;line-height:1.7;max-height:480px;overflow-y:auto;margin:0;white-space:pre-wrap}
</style></head><body><div class="wrap">
<h1>merge<b>lens</b> · 运行日志 <a href="/">← 返回看板</a></h1>
<div class="sub">每 10s 自动刷新 · webhook 事件保留最近 30 条 · 进程日志保留最近 500 行（服务启动后累计）</div>

<div class="card"><h3>Webhook 事件与处理决定（最新在前）</h3>
  <div style="overflow-x:auto"><table><tbody>${evRows}</tbody></table></div>
</div>

<div class="card"><h3>进程日志（最新在后）</h3>
  <pre>${esc(logLines.join("\n") || "（本次启动后还没有日志）")}</pre>
</div>
<script>document.querySelector('pre').scrollTop = 1e9;</script>
</div></body></html>`;
}

/** Skill 管理页：内置与仓库自定义都可在线编辑，支持效果回放。 */
export function renderSkillsPage(builtinFiles: Array<{ file: string; raw: string; skill: Skill }>): string {
  const builtinCards = builtinFiles.map((b, i) => `
  <details class="skillcard">
    <summary><span class="mono" style="font-weight:700">${esc(b.skill.name)}</span>
      <span class="badge ok">内置</span>
      <span class="hint" style="margin-left:auto">trigger: ${esc(b.skill.triggers.join(", ") || "全部文件")} · weight ${b.skill.severityWeight}</span>
      <button onclick="event.preventDefault();event.stopPropagation();editBuiltin(${i})">编辑</button>
    </summary>
    <pre>${esc(b.skill.body)}</pre>
  </details>`).join("");
  // 转义 < 防止 skill 正文里的 </script>/尖括号打断页面脚本
  const builtinJson = JSON.stringify(builtinFiles.map((b) => ({ file: b.file, raw: b.raw, name: b.skill.name })))
    .replace(/</g, "\\u003c");

  const TEMPLATE = [
    "---", "name: my-rule", 'trigger: "src/**/*.{ts,tsx}"', "severity_weight: 1.0", "---", "",
    "# 规则标题", "", "用自然语言描述这条团队审查规则：", "- 什么情况必须报告，严重度如何判定", "- 什么情况属于例外不要报",
  ].join("\n");

  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mergelens · Skills</title>
<style>
:root{--page:#F4F6F5;--surface:#fff;--ink:#17241F;--ink2:#55655E;--ink3:#8A968F;
  --line:#E3E8E5;--accent:#0E7A6E;--good:#0B7C3E;--bad:#C13333;--warn:#9A6700;
  --good-bg:rgba(11,124,62,.1);--bad-bg:rgba(193,51,51,.1)}
@media(prefers-color-scheme:dark){:root{--page:#0E1412;--surface:#161D1A;--ink:#E7EDEA;
  --ink2:#A3B0A9;--ink3:#71807A;--line:#26302B;--accent:#3FBFAE;--good:#3FAE6A;--bad:#E06060;--warn:#D9A62E;
  --good-bg:rgba(63,174,106,.14);--bad-bg:rgba(224,96,96,.13)}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);
  font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px 80px}
h1{font-size:18px;margin:0}h1 b{color:var(--accent)}h1 a{color:var(--accent);font-size:13px;font-weight:400;margin-left:10px}
.sub{color:var(--ink3);font-size:12px;margin:2px 0 22px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:18px 20px;margin-bottom:14px}
.card h3{font-size:13px;margin:0 0 12px}
.mono{font-family:Consolas,monospace;font-size:12px}.hint{font-size:11px;color:var(--ink3)}
input[type=text],textarea{width:100%;padding:7px 10px;border-radius:8px;border:1px solid var(--line);
  background:var(--surface);color:var(--ink);font:inherit;font-size:13px}
textarea{font-family:Consolas,monospace;font-size:12px;line-height:1.7}
button{padding:7px 14px;border-radius:8px;border:1px solid var(--line);background:var(--surface);
  color:var(--ink);font:inherit;font-size:13px;font-weight:600;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.badge{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px}
.badge.ok{color:var(--good);background:var(--good-bg)}.badge.bad{color:var(--bad);background:var(--bad-bg)}
.skillcard{border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin-bottom:8px}
.skillcard summary{display:flex;gap:10px;align-items:center;cursor:pointer;list-style:none}
.skillcard summary::-webkit-details-marker{display:none}
.skillcard pre{background:var(--page);border-radius:8px;padding:12px;overflow-x:auto;font-size:12px;line-height:1.7}
.repo-item{display:flex;gap:10px;align-items:center;padding:8px 4px;border-bottom:1px solid var(--line);font-size:13px}
.repo-item:last-child{border-bottom:none}
.finding{border-left:3px solid var(--warn);padding:8px 12px;margin:8px 0;background:var(--page);border-radius:0 8px 8px 0}
.finding.critical{border-left-color:var(--bad)}.finding.serious{border-left-color:#B4542E}
.finding b{font-size:13px}.finding p{margin:4px 0 0;font-size:12.5px;color:var(--ink2)}
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--page);
  padding:10px 18px;border-radius:9px;font-size:13px;opacity:0;transition:opacity .25s;pointer-events:none;z-index:99}
#toast.on{opacity:1}
</style></head><body><div class="wrap">
<h1>merge<b>lens</b> · Skills <a href="/">← 返回看板</a><a href="/config">⚙ 配置</a></h1>
<div class="sub">审查规则即 markdown。内置规则只读；仓库自定义规则在线编辑，保存 = 向该仓库提交 .mergelens/skills/*.md</div>

<div class="card"><h3>内置 Skill（随 mergelens 发布，编辑后对所有项目生效）</h3>${builtinCards}</div>

<div class="card"><h3>仓库自定义 Skill</h3>
  <div class="bar" style="margin-bottom:10px">
    <input type="text" id="proj" placeholder="group/project" style="max-width:260px">
    <button onclick="loadRepo()">加载</button>
    <button onclick="newSkill()">+ 新建</button>
    <input type="text" id="admin_token" placeholder="管理口令（设置了 ADMIN_TOKEN 才需要）" style="max-width:240px">
  </div>
  <div id="repoList" class="hint">输入仓库路径后点「加载」</div>
</div>

<div class="card" id="editorCard" style="display:none"><h3>编辑：<span class="mono" id="editName"></span>
  <span class="badge ok" id="editScope"></span></h3>
  <div class="bar" style="margin-bottom:8px">
    <input type="text" id="skillFile" placeholder="文件名（如 no-raw-fetch.md）" style="max-width:260px">
  </div>
  <textarea id="skillBody" rows="16" spellcheck="false"></textarea>
  <div class="bar" style="margin-top:10px">
    <button class="primary" onclick="commitSkill()">提交到仓库</button>
    <input type="text" id="replayMr" placeholder="MR 号（回放用）" style="max-width:130px">
    <button onclick="replay()">▶ 效果回放</button>
    <span class="hint">回放 = 用这条规则试跑指定 MR，只在下方显示结果，不发布任何评论</span>
  </div>
  <div id="replayOut"></div>
</div>
<div id="toast"></div>

<script>
const $ = id => document.getElementById(id);
const BUILTIN = ${builtinJson};
let editMode = 'repo'; // 'repo' | 'builtin'
$('admin_token').value = localStorage.getItem('mergelens_admin') || '';
function toast(m){ $('toast').textContent = m; $('toast').classList.add('on');
  clearTimeout(window.__t); window.__t = setTimeout(()=>$('toast').classList.remove('on'), 3200); }
async function api(url, opts){
  localStorage.setItem('mergelens_admin', $('admin_token').value);
  const res = await fetch(url, { ...opts,
    headers: { 'content-type':'application/json', 'x-admin-token': $('admin_token').value } });
  const data = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error || res.status);
  return data;
}
let repoSkills = [];
const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
async function loadRepo(){
  const p = $('proj').value.trim();
  if(!p) return toast('先填仓库路径');
  try{
    const d = await api('/api/skills?project=' + encodeURIComponent(p));
    repoSkills = d.repo;
    $('repoList').innerHTML = d.repo.length === 0
      ? '该仓库还没有自定义 skill（.mergelens/skills/ 为空），点「+ 新建」创建第一条'
      : d.repo.map((s, i) =>
          '<div class="repo-item"><span class="mono" style="font-weight:700">' + escHtml(s.name) +
          '</span><span class="hint">trigger: ' + escHtml(s.triggers.join(', ') || '全部文件') +
          '</span><button style="margin-left:auto" onclick="editRepo(' + i + ')">编辑</button></div>'
        ).join('');
    toast('已加载 ' + d.repo.length + ' 条自定义 skill');
  }catch(e){ toast('加载失败：' + e.message); }
}
function editRepo(i){ editSkill(JSON.stringify(repoSkills[i]), 'repo'); }
function editSkill(json, mode){
  const s = JSON.parse(json);
  editMode = mode || 'repo';
  $('editorCard').style.display = '';
  $('editName').textContent = s.name;
  $('editScope').textContent = editMode === 'builtin' ? '内置 · 保存写服务端，全部项目生效' : '仓库自定义 · 保存提交到上方仓库';
  $('skillFile').value = s.file || (s.name + '.md');
  $('skillBody').value = s.raw;
  $('replayOut').innerHTML = '';
  $('editorCard').scrollIntoView({behavior:'smooth'});
}
function editBuiltin(i){ editSkill(JSON.stringify(BUILTIN[i]), 'builtin'); }
function newSkill(){
  editSkill(JSON.stringify({ name: '（新规则）', file: 'my-rule.md', raw: ${JSON.stringify(TEMPLATE)} }), 'repo');
}
async function commitSkill(){
  const file = $('skillFile').value.trim(), content = $('skillBody').value;
  try{
    if(editMode === 'builtin'){
      const r = await api('/api/skills/builtin', { method:'POST', body: JSON.stringify({ file, content }) });
      toast('内置规则已保存（' + r.path + '），下次审查生效');
    } else {
      const p = $('proj').value.trim();
      if(!p) return toast('先在上方填仓库路径');
      const r = await api('/api/skills/commit', { method:'POST', body: JSON.stringify({ project: p, file, content }) });
      toast('已提交到 ' + p + ' 的 ' + r.branch + ' 分支'); loadRepo();
    }
  }catch(e){ toast('保存失败：' + e.message); }
}
async function replay(){
  const p = $('proj').value.trim(), mr = $('replayMr').value.trim();
  if(!p || !mr) return toast('需要仓库路径和 MR 号');
  $('replayOut').innerHTML = '<p class="hint">回放中（调用一次 AI，约 10-60 秒）……</p>';
  try{
    const r = await api('/api/skills/test', { method:'POST', body: JSON.stringify({
      project: p, iid: Number(mr), file: $('skillFile').value.trim(), content: $('skillBody').value }) });
    $('replayOut').innerHTML =
      '<p class="hint">审查了 ' + r.fileCount + ' 个文件，产出 ' + r.findings.length + ' 条发现：</p>' +
      (r.findings.map(f =>
        '<div class="finding ' + f.severity + '"><b>[' + f.severity + '] ' + f.title +
        '</b> <span class="hint">' + f.file + (f.line ? ':' + f.line : '') + ' · 置信度 ' + f.confidence + '%</span>' +
        '<p>' + f.detail + '</p></div>').join('') || '<p class="hint">没有发现 —— 规则可能太宽松或该 MR 不涉及</p>');
  }catch(e){ $('replayOut').innerHTML = ''; toast('回放失败：' + e.message); }
}
</script>
</div></body></html>`;
}

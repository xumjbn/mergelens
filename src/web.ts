import type { Config } from "./types.js";
import type { FeedbackRecord, ReviewRecord } from "./store.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 服务端渲染的看板首页：指标、14 天趋势、最近审查列表。 */
export function renderDashboard(records: ReviewRecord[], feedback: FeedbackRecord[], cfg: Config): string {
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
<h1>merge<b>lens</b> · 审查看板 <a href="/config" style="font-size:13px;font-weight:400;color:var(--accent);margin-left:10px">⚙ 配置</a></h1>
<div class="sub">数据每 60s 自动刷新 · JSON API：<span class="mono">/api/reviews</span> · 健康检查：<span class="mono">/health</span></div>

<div class="tiles">
  <div class="card"><div class="k">累计审查</div><div class="v">${total}<small> 次（近7天 ${week.length}）</small></div></div>
  <div class="card"><div class="k">发现问题</div><div class="v">${critical + serious + suggestion}<small> 🔴${critical} 🟠${serious} 🟡${suggestion}</small></div></div>
  <div class="card"><div class="k">门禁拦截率</div><div class="v">${blockRate}<small>%（${needsWork} 次建议修复）</small></div></div>
  <div class="card"><div class="k">建议采纳率</div><div class="v">${adoption === null ? "—" : adoption + '<small>%</small>'}<small> 👍${fSum((r) => r.up)} 👎${fSum((r) => r.down)} · 已结算 ${feedback.length} 个 MR</small></div></div>
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

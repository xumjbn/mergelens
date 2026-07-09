/** Minimal smoke tests, run with: npx tsx tests/run.ts */
import assert from "node:assert";
import { parseDiff, matchGlob, isIgnored, annotate, addedLineSet, prepareChanges } from "../src/diff.js";
import { parseSkill, skillApplies } from "../src/skills.js";
import { extractJson } from "../src/ai.js";

let passed = 0;
function t(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log("  ✓ " + name);
}

/* ---- diff parsing ---- */
const DIFF = `@@ -18,6 +18,14 @@ export class Handler {
 async function handlePaymentCallback(req) {
+  const idemKey = \`cb:\${req.orderId}\`;
+  if (await redis.exists(idemKey)) return ok('duplicated');

-  const order = await db.findOrder(req.orderId);
+  const order = await db.query("SELECT * FROM orders WHERE id = " + req.orderId);
   if (!order) throw new NotFoundError(req.orderId);
 }`;

t("parseDiff 行号计算", () => {
  const f = parseDiff("src/handler.ts", DIFF);
  assert.equal(f.addedCount, 3);
  assert.equal(f.deletedCount, 1);
  const adds = f.lines.filter((l) => l.type === "add");
  assert.deepEqual(adds.map((l) => l.newLine), [19, 20, 22]);
  const del = f.lines.find((l) => l.type === "del")!;
  assert.equal(del.oldLine, 20);
  const lastCtx = f.lines.at(-1)!;
  assert.equal(lastCtx.newLine, 24);
});

t("addedLineSet / annotate", () => {
  const f = parseDiff("a.ts", DIFF);
  const s = addedLineSet(f);
  assert.ok(s.has(22) && !s.has(23));
  assert.ok(annotate(f).includes("   22 +"));
});

/* ---- glob ---- */
t("matchGlob", () => {
  assert.ok(matchGlob("*.lock", "yarn.lock"));
  assert.ok(matchGlob("*.lock", "deep/dir/yarn.lock"));
  assert.ok(matchGlob("dist/**", "dist/a/b.js"));
  assert.ok(matchGlob("src/**/*.{ts,tsx}", "src/a/b/c.tsx"));
  assert.ok(!matchGlob("src/**/*.{ts,tsx}", "lib/a.ts"));
  assert.ok(!matchGlob("*.min.js", "app.js"));
});

t("prepareChanges 忽略与预算", () => {
  const mk = (p: string, d: string) => ({
    old_path: p, new_path: p, new_file: false, deleted_file: false, renamed_file: false, diff: d,
  });
  const { files, skipped } = prepareChanges(
    [mk("src/a.ts", DIFF), mk("yarn.lock", DIFF)],
    ["*.lock"],
    1000,
  );
  assert.equal(files.length, 1);
  assert.deepEqual(skipped, ["yarn.lock"]);
});

/* ---- skills ---- */
t("parseSkill frontmatter", () => {
  const s = parseSkill("x.md", `---\nname: sec\ntrigger: "*.sql, **/dao/**"\nseverity_weight: 1.4\n---\n\n规则正文`);
  assert.equal(s.name, "sec");
  assert.deepEqual(s.triggers, ["*.sql", "**/dao/**"]);
  assert.equal(s.severityWeight, 1.4);
  assert.equal(s.body, "规则正文");
  assert.ok(skillApplies(s, ["app/dao/user.ts"]));
  assert.ok(!skillApplies(s, ["web/app.tsx"]));
});

t("parseSkill 无 frontmatter", () => {
  const s = parseSkill("correctness.md", "# 规则");
  assert.equal(s.name, "correctness");
  assert.equal(s.triggers.length, 0);
  assert.ok(skillApplies(s, ["anything.py"]));
});

/* ---- incremental ---- */
import { lastReviewedSha, previousFindingTitles, reviewMarker } from "../src/review/incremental.js";

t("增量：sha 标记提取（取最后一次）", () => {
  const notes = [
    "普通人类评论",
    reviewMarker("aaaa1111aaaa1111") + "\n## 审查结果 ...",
    "又一条评论",
    reviewMarker("bbbb2222bbbb2222") + "\n## 审查结果 ...",
  ];
  assert.equal(lastReviewedSha(notes), "bbbb2222bbbb2222");
  assert.equal(lastReviewedSha(["没有标记"]), null);
});

t("增量：历史发现标题提取", () => {
  const titles = previousFindingTitles([
    "🔴 高危 **金额比较使用浮点等值判断**（correctness · 置信度 92%）",
    "| 🟠 严重 | `a.ts:23` | **SQL 拼接注入风险** | security |",
  ]);
  assert.ok(titles.includes("金额比较使用浮点等值判断"));
  assert.ok(titles.includes("SQL 拼接注入风险"));
});

/* ---- store ---- */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { recordReview, readReviews } from "../src/store.js";

t("store：JSONL 写入与读取", () => {
  process.env.MERGELENS_DATA = mkdtempSync(pjoin(tmpdir(), "mergelens-test-"));
  const rec = {
    ts: "2026-07-09T10:00:00.000Z", project: "g/r", iid: 1, title: "t",
    verdict: "approve" as const, critical: 0, serious: 1, suggestion: 2,
    filtered: 3, incremental: true, dryRun: false, durationMs: 1200, model: "m",
  };
  recordReview(rec);
  recordReview({ ...rec, iid: 2, verdict: "needs-work" as const });
  const all = readReviews();
  assert.equal(all.length, 2);
  assert.equal(all[1].iid, 2);
  assert.equal(all[0].serious, 1);
  delete process.env.MERGELENS_DATA;
});

/* ---- config 两级继承 ---- */
import { mergeFileConfig } from "../src/config.js";

t("config：仓库配置覆盖服务端默认", () => {
  const base = loadConfig(); // 默认配置
  const merged = mergeFileConfig(base, {
    ai: { model: "deepseek-chat", base_url: "http://evil" },
    review: { max_comments: 3, severity_gate: "critical" },
    skills: { enabled: ["security"] },
    notify: { on: "all" },
  });
  assert.equal(merged.ai.model, "deepseek-chat");
  assert.equal(merged.review.maxComments, 3);
  assert.equal(merged.review.severityGate, "critical");
  assert.deepEqual(merged.review.enabledSkills, ["security"]);
  assert.equal(merged.notify.on, "all");
  // 未覆盖项继承默认
  assert.equal(merged.review.maxDiffLines, base.review.maxDiffLines);
  assert.equal(merged.review.verify, true);
});

/* ---- skills 合并 ---- */
import { mergeSkills } from "../src/skills.js";

t("skills：仓库同名覆盖内置 + enabled 过滤", () => {
  const builtin = [parseSkill("security.md", "内置安全规则"), parseSkill("correctness.md", "内置正确性")];
  const repo = [parseSkill("security.md", "团队加强版安全规则"), parseSkill("no-fetch.md", "禁止 fetch")];
  const all = mergeSkills(builtin, repo, "all");
  assert.equal(all.length, 3);
  assert.equal(all.find((s) => s.name === "security")!.body, "团队加强版安全规则");
  const filtered = mergeSkills(builtin, repo, ["no-fetch"]);
  assert.deepEqual(filtered.map((s) => s.name), ["no-fetch"]);
});

/* ---- config yaml 导出回读 ---- */
import { fileConfigToYaml } from "../src/config.js";
import YAML from "yaml";

t("config：页面 JSON → yaml → 回读一致", () => {
  const submitted = {
    ai: { provider: "deepseek", model: "deepseek-chat", light_model: undefined, temperature: 0.2 },
    review: { max_comments: 5, verify: false, ignore_paths: ["*.lock", "dist/**"] },
    skills: { enabled: ["security"] },
    notify: { on: "all" },
  };
  const yaml = fileConfigToYaml(submitted);
  const back = YAML.parse(yaml);
  assert.equal(back.ai.provider, "deepseek");
  assert.equal(back.ai.light_model, undefined); // undefined/空值被清理
  assert.equal(back.review.verify, false);      // false 要保留
  assert.deepEqual(back.review.ignore_paths, ["*.lock", "dist/**"]);
  const merged = mergeFileConfig(loadConfig(), back);
  assert.equal(merged.review.maxComments, 5);
  assert.equal(merged.notify.on, "all");
});

/* ---- notify ---- */
import { dingtalkSign, buildMarkdown } from "../src/notify.js";

t("钉钉加签：确定性 HMAC", () => {
  const s1 = dingtalkSign("SECabc", 1720500000000);
  const s2 = dingtalkSign("SECabc", 1720500000000);
  assert.equal(s1, s2);
  assert.ok(s1.length > 20 && !s1.includes("+")); // 已 urlEncode
  assert.notEqual(s1, dingtalkSign("SECother", 1720500000000));
});

t("推送消息构造", () => {
  const { title, text } = buildMarkdown({
    project: "g/repo",
    mr: { iid: 42, title: "支付回调", author: { username: "li" }, source_branch: "f", target_branch: "main",
      description: "", sha: "", diff_refs: { base_sha: "", head_sha: "", start_sha: "" },
      web_url: "https://gitlab.example.com/g/repo/-/merge_requests/42" },
    verdict: "needs-work",
    counts: { critical: 1, serious: 2, suggestion: 0 },
    incremental: true,
  });
  assert.ok(title.includes("g/repo!42"));
  assert.ok(text.includes("建议修复后合并") && text.includes("🔴 1") && text.includes("增量"));
  assert.ok(text.includes("merge_requests/42"));
});

/* ---- web ---- */
import { renderDashboard } from "../src/web.js";
import { loadConfig } from "../src/config.js";

t("看板渲染（含采纳率）", () => {
  const html = renderDashboard([{
    ts: new Date().toISOString(), project: "g/r", iid: 7, title: "标题<script>",
    verdict: "needs-work", critical: 1, serious: 0, suggestion: 2, filtered: 1,
    incremental: false, dryRun: false, durationMs: 90000, model: "m",
  }], [
    { ts: "2026-07-09T10:00:00Z", project: "g/r", iid: 7, findings: 4, resolved: 3, up: 2, down: 1 },
  ], loadConfig());
  assert.ok(html.includes("审查看板"));
  assert.ok(html.includes("g/r!7"));
  assert.ok(!html.includes("<script>")); // XSS 转义
  assert.ok(html.includes("⛔ 建议修复"));
  assert.ok(html.includes("75")); // 采纳率 3/4
  assert.ok(html.includes("👍2 👎1"));
});

/* ---- memory 记忆库 ---- */
import { normalizeTitle, recurringPatterns, riskyFiles } from "../src/memory.js";

t("memory：标题归一化聚类", () => {
  assert.equal(normalizeTitle("SQL 拼接存在注入风险 (第23行)"), normalizeTitle("SQL 拼接存在注入风险（第 8 行）"));
  assert.notEqual(normalizeTitle("空指针解引用"), normalizeTitle("SQL 注入"));
});

t("memory：惯犯模式与风险文件", () => {
  const mk = (title: string, file: string, severity = "serious") =>
    ({ ts: "t", project: "g/r", iid: 1, file, severity, title, skill: "s" });
  const mem = [
    mk("金额浮点比较 (第23行)", "a.ts"), mk("金额浮点比较（第8行）", "a.ts"),
    mk("SQL 注入", "a.ts", "critical"), mk("缺少测试", "b.ts", "suggestion"),
    mk("其他项目的", "c.ts"),
  ];
  mem[4].project = "other/repo";
  const patterns = recurringPatterns(mem, "g/r");
  assert.equal(patterns.length, 1); // 只有"金额浮点比较"出现两次（归一化后同键）
  assert.equal(patterns[0].count, 2);
  const risky = riskyFiles(mem, "g/r", 2);
  assert.equal(risky.length, 1);
  assert.equal(risky[0].file, "a.ts");
  assert.equal(risky[0].total, 3);
  assert.equal(risky[0].critical, 3); // critical + 2 条 serious
});

/* ---- skills 页 ---- */
import { renderSkillsPage } from "../src/web.js";
import { loadSkills } from "../src/skills.js";

t("Skill 页渲染（内置列表）", () => {
  const html = renderSkillsPage(loadSkills("skills", "all"));
  assert.ok(html.includes("correctness"));
  assert.ok(html.includes("security"));
  assert.ok(html.includes("效果回放"));
  assert.ok(html.includes(".mergelens/skills"));
});

/* ---- assistant ---- */
import { stripMention } from "../src/assistant.js";

t("@提及/触发词剥离", () => {
  assert.equal(stripMention("@review-bot 这条是误报吧？", ["@review-bot", "@ai"]), "这条是误报吧？");
  assert.equal(stripMention("@ai 重新审查", ["", "@ai"]), "重新审查");
  assert.equal(stripMention("请 @review-bot 看看 @ai", ["@review-bot", "@ai"]), "请  看看");
});

/* ---- json extraction ---- */
t("extractJson 容错", () => {
  assert.deepEqual(extractJson("前置说明\n```json\n[{\"a\":1}]\n```"), [{ a: 1 }]);
  assert.deepEqual(extractJson('{"refuted": false, "reason": "含 } 的\\"引号\\""}'),
    { refuted: false, reason: '含 } 的"引号"' });
  assert.deepEqual(extractJson("[]"), []);
});

console.log(`\n${passed} 个测试全部通过`);

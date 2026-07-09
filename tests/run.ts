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

/* ---- json extraction ---- */
t("extractJson 容错", () => {
  assert.deepEqual(extractJson("前置说明\n```json\n[{\"a\":1}]\n```"), [{ a: 1 }]);
  assert.deepEqual(extractJson('{"refuted": false, "reason": "含 } 的\\"引号\\""}'),
    { refuted: false, reason: '含 } 的"引号"' });
  assert.deepEqual(extractJson("[]"), []);
});

console.log(`\n${passed} 个测试全部通过`);

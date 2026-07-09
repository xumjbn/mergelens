import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 极简持久化：JSONL 追加写，无数据库依赖。
 * 数据目录：MERGELENS_DATA 环境变量，默认 ./data
 * 用途：stats 命令、后续 Web 看板的数据源。
 */

export interface ReviewRecord {
  ts: string;
  project: string;
  iid: number;
  title: string;
  verdict: "approve" | "needs-work";
  critical: number;
  serious: number;
  suggestion: number;
  filtered: number;
  incremental: boolean;
  dryRun: boolean;
  durationMs: number;
  model: string;
}

function dataDir(): string {
  return process.env.MERGELENS_DATA ?? join(process.cwd(), "data");
}

function reviewsFile(): string {
  return join(dataDir(), "reviews.jsonl");
}

export function recordReview(r: ReviewRecord): void {
  try {
    mkdirSync(dataDir(), { recursive: true });
    appendFileSync(reviewsFile(), JSON.stringify(r) + "\n", "utf8");
  } catch (err) {
    console.error("[store] 写入审查记录失败：" + (err as Error).message);
  }
}

export function readReviews(): ReviewRecord[] {
  const f = reviewsFile();
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l) as ReviewRecord; } catch { return null; }
    })
    .filter((r): r is ReviewRecord => r !== null);
}

/** stats 命令的汇总输出。 */
export function formatStats(records: ReviewRecord[]): string {
  if (records.length === 0) {
    return "还没有审查记录（数据文件 data/reviews.jsonl，dry-run 也会记录）。";
  }
  const real = records.filter((r) => !r.dryRun);
  const sum = (f: (r: ReviewRecord) => number) => records.reduce((s, r) => s + f(r), 0);
  const needsWork = records.filter((r) => r.verdict === "needs-work").length;
  const avgMs = Math.round(sum((r) => r.durationMs) / records.length);

  const lines = [
    `审查 ${records.length} 次（正式 ${real.length} / dry-run ${records.length - real.length}）`,
    `发现：🔴 ${sum((r) => r.critical)} 高危 · 🟠 ${sum((r) => r.serious)} 严重 · 🟡 ${sum((r) => r.suggestion)} 建议` +
      ` · 自动过滤 ${sum((r) => r.filtered)} 条低置信度`,
    `门禁拦截率：${Math.round((needsWork / records.length) * 100)}%（${needsWork}/${records.length}）· 平均耗时 ${(avgMs / 1000).toFixed(1)}s`,
    "",
    "最近 10 次：",
  ];
  for (const r of records.slice(-10).reverse()) {
    const flag = r.verdict === "needs-work" ? "⛔" : "✅";
    const tags = [r.incremental ? "增量" : "", r.dryRun ? "dry-run" : ""].filter(Boolean).join(",");
    lines.push(
      `  ${r.ts.slice(0, 16).replace("T", " ")}  ${flag} ${r.project}!${r.iid}` +
      `  🔴${r.critical} 🟠${r.serious} 🟡${r.suggestion}${tags ? `  [${tags}]` : ""}  ${r.title.slice(0, 40)}`,
    );
  }
  return lines.join("\n");
}

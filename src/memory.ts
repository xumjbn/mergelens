import type { MemoryRecord, SkillOutcome } from "./store.js";

/**
 * 审查记忆库的分析函数：
 * - recurringPatterns：同一问题模式反复出现 → 审查时注入提示词并提级（"惯犯"）
 * - riskyFiles：历史发现聚集的文件 → 风险热力，审查时要求重点检查
 */

/** 标题归一化：去数字/符号/大小写，留语义骨架，用于聚类同类问题。 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[0-9]/g, "")
    .replace(/[^\p{L}]+/gu, "")
    .slice(0, 48);
}

export interface Pattern {
  title: string;
  count: number;
}

/** 项目内反复出现（≥minCount 次）的问题模式，按出现次数排序。 */
export function recurringPatterns(
  records: MemoryRecord[],
  project: string,
  minCount = 2,
  top = 8,
): Pattern[] {
  const groups = new Map<string, { title: string; count: number }>();
  for (const r of records) {
    if (r.project !== project) continue;
    const key = normalizeTitle(r.title);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { title: r.title, count: 1 });
  }
  return [...groups.values()]
    .filter((g) => g.count >= minCount)
    .sort((a, b) => b.count - a.count)
    .slice(0, top);
}

export interface SkillTrust {
  /** 置信度缩放系数，0.75–1.10；样本不足 5 条时恒为 1 */
  factor: number;
  samples: number;
  adoption: number;
}

/**
 * 反馈自动调权：某 skill 的历史发现被采纳（resolve）多 → 系数升；
 * 采纳率低或净 👎 多 → 系数降。审查时用系数缩放该 skill 发现的置信度，
 * 低信任 skill 的发现更容易被 min_confidence 门槛过滤，无需人工调配置。
 */
export function skillTrust(outcomes: SkillOutcome[], skill: string): SkillTrust {
  const mine = outcomes.filter((o) => o.skill === skill);
  const samples = mine.length;
  if (samples < 5) return { factor: 1, samples, adoption: 0 };
  const adoption = mine.filter((o) => o.resolved).length / samples;
  const netDown = mine.reduce((s, o) => s + o.down - o.up, 0);
  const raw = 0.8 + 0.4 * adoption - 0.03 * Math.max(0, netDown);
  const factor = Math.min(1.1, Math.max(0.75, raw));
  return { factor: Math.round(factor * 100) / 100, samples, adoption: Math.round(adoption * 100) / 100 };
}

export interface RiskyFile {
  file: string;
  total: number;
  critical: number;
}

/** 历史发现聚集的高风险文件（≥minFindings 条），按 高危数 > 总数 排序。 */
export function riskyFiles(
  records: MemoryRecord[],
  project: string,
  minFindings = 2,
  top = 10,
): RiskyFile[] {
  const byFile = new Map<string, RiskyFile>();
  for (const r of records) {
    if (r.project !== project || !r.file) continue;
    const f = byFile.get(r.file) ?? { file: r.file, total: 0, critical: 0 };
    f.total++;
    if (r.severity === "critical" || r.severity === "serious") f.critical++;
    byFile.set(r.file, f);
  }
  return [...byFile.values()]
    .filter((f) => f.total >= minFindings)
    .sort((a, b) => b.critical - a.critical || b.total - a.total)
    .slice(0, top);
}

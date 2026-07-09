import type { Config, Finding, MrChange, MrInfo, ParsedFile, Severity, Skill } from "../types.js";
import { GitLab } from "../gitlab.js";
import { chat, extractJson } from "../ai.js";
import { addedLineSet, annotate, prepareChanges } from "../diff.js";
import { loadRepoSkills, loadSkills, mergeSkills, skillApplies } from "../skills.js";
import { resolveProjectConfig } from "../config.js";
import { lastReviewedSha, previousFindingTitles, reviewMarker } from "./incremental.js";
import { recordMemory, recordReview, readMemory } from "../store.js";
import { notifyReview } from "../notify.js";
import { recurringPatterns, riskyFiles, type Pattern, type RiskyFile } from "../memory.js";

const SEV_ORDER: Record<Severity, number> = { critical: 0, serious: 1, suggestion: 2 };
const SEV_LABEL: Record<Severity, string> = { critical: "🔴 高危", serious: "🟠 严重", suggestion: "🟡 建议" };

export interface ReviewResult {
  mr: MrInfo;
  findings: Finding[];
  filtered: number;
  skippedFiles: string[];
  verdict: "approve" | "needs-work";
  summary: string;
  /** 本次是否只审了自上次以来的增量 diff */
  incremental: boolean;
  /** 该 head sha 已审查过，本次未做任何事 */
  skipped?: boolean;
}

/* ---------------- prompts ---------------- */

function reviewSystemPrompt(cfg: Config, skill: Skill): string {
  return `你是一名严格但务实的资深代码审查员，正在审查一个 GitLab Merge Request 的 diff。

你本次只负责一个审查维度，规则如下：

${skill.body}

要求：
- 只报告你有把握的问题，宁缺毋滥；风格类琐碎意见不要报。
- 每条发现必须锚定到 diff 中标注的「新文件行号」（行首的数字）。只允许引用带 + 号的新增行；如果问题跨多行，选最核心的一行。
- 用${cfg.review.language}输出。
- 严格输出 JSON 数组（可以为空 []），不要输出任何其他文字：
[{"file":"路径","line":行号,"severity":"critical|serious|suggestion","title":"一句话问题","detail":"具体说明+为什么是问题","confidence":0到100,"fix":"可选的修复建议代码"}]`;
}

function reviewUserPrompt(
  mr: MrInfo,
  files: ParsedFile[],
  prevTitles: string[],
  patterns: Pattern[] = [],
  risky: RiskyFile[] = [],
): string {
  const prev = prevTitles.length > 0
    ? `\n## 此前审查已指出过的问题（不要重复报告，除非本次改动引入了新的实例）\n${prevTitles.map((t) => `- ${t}`).join("\n")}\n`
    : "";
  const mem = patterns.length > 0
    ? `\n## 本团队历史审查中反复出现的问题模式（惯犯——遇到同类问题请提高一级严重度，并注明"该问题模式团队已出现 N 次"）\n${patterns.map((p) => `- ${p.title}（已出现 ${p.count} 次）`).join("\n")}\n`
    : "";
  const heat = risky.length > 0
    ? `\n## 高风险文件（历史审查中问题聚集，请对这些文件的改动从严审查）\n${risky.map((f) => `- ${f.file}（历史发现 ${f.total} 条，其中高危/严重 ${f.critical} 条）`).join("\n")}\n`
    : "";
  return `## MR 信息
标题：${mr.title}
描述：${(mr.description || "（无）").slice(0, 1500)}
分支：${mr.source_branch} → ${mr.target_branch}
${prev}${mem}${heat}
## Diff（行首数字 = 新文件行号，+ 新增，- 删除）

${files.map(annotate).join("\n\n")}`;
}

const VERIFY_SYSTEM = `你是一名审查意见的质疑者。给你一条 AI 代码审查发现和相关 diff 片段，你的任务是尽力**推翻**它：
它是否误读了代码？是否在该上下文中根本不成立？是否是无关痛痒的吹毛求疵？
拿不准时倾向于推翻。严格输出 JSON：{"refuted": true|false, "reason": "一句话理由"}`;

/* ---------------- pipeline ---------------- */

export async function reviewMr(
  cfg: Config,
  project: string | number,
  iid: number,
  opts: { dryRun?: boolean; fullReview?: boolean } = {},
): Promise<ReviewResult> {
  const gl = new GitLab(cfg);
  const t0 = Date.now();

  console.error(`[review] 拉取 MR ${project}!${iid} ...`);
  const mr = await gl.getMr(project, iid);

  // 项目级配置：从目标仓库 target 分支拉 .ai-review.yml 叠加到服务端配置
  const resolved = await resolveProjectConfig(cfg, gl, project, mr.target_branch);
  cfg = resolved.cfg;
  console.error(`[review] 配置来源：${resolved.source}`);

  // 增量审查：从本 bot 历史评论里找上次审到的 sha，只比对增量
  let changes: MrChange[] | undefined;
  let incremental = false;
  let prevTitles: string[] = [];
  if (cfg.review.incremental && !opts.fullReview) {
    try {
      const me = (await gl.getCurrentUser()).username;
      const myNotes = (await gl.getMrNotes(project, iid))
        .filter((n) => n.author?.username === me)
        .map((n) => n.body);
      const last = lastReviewedSha(myNotes);
      prevTitles = previousFindingTitles(myNotes);
      if (last === mr.sha) {
        console.error(`[review] head ${mr.sha.slice(0, 8)} 已审查过，跳过`);
        return {
          mr, findings: [], filtered: 0, skippedFiles: [], verdict: "approve",
          summary: `该版本（${mr.sha.slice(0, 8)}）已审查过，无新提交。需要重审请加 --full。`,
          incremental: true, skipped: true,
        };
      }
      if (last) {
        const cmp = await gl.compare(project, last, mr.sha);
        if (cmp.diffs?.length > 0) {
          changes = cmp.diffs;
          incremental = true;
          console.error(`[review] 增量审查：${last.slice(0, 8)}..${mr.sha.slice(0, 8)}，${cmp.diffs.length} 个文件`);
        }
      }
    } catch (err) {
      console.error(`[review] 增量定位失败（${(err as Error).message}），回退全量审查`);
    }
  }
  changes ??= await gl.getMrChanges(project, iid);

  const { files, skipped, truncated } = prepareChanges(
    changes,
    cfg.review.ignorePaths,
    cfg.review.maxDiffLines,
  );
  if (files.length === 0) {
    return {
      mr, findings: [], filtered: 0, skippedFiles: skipped, verdict: "approve",
      summary: "没有可审查的文本改动（可能全部命中忽略规则）。", incremental,
    };
  }

  const changedPaths = files.map((f) => f.path);
  const builtin = loadSkills(cfg.review.skillsDir, "all");
  const repoSkills = await loadRepoSkills(gl, project, mr.target_branch);
  if (repoSkills.length > 0) {
    console.error(`[review] 仓库自定义 skill（.mergelens/skills/）：${repoSkills.map((s) => s.name).join(", ")}`);
  }
  const skills = mergeSkills(builtin, repoSkills, cfg.review.enabledSkills)
    .filter((s) => skillApplies(s, changedPaths));
  if (skills.length === 0) throw new Error(`未找到可用 skill（目录 ${cfg.review.skillsDir}）`);
  console.error(`[review] ${files.length} 个文件，${skills.length} 个 skill：${skills.map((s) => s.name).join(", ")}`);

  // 1. run every applicable skill in parallel（注入记忆库的惯犯模式与风险热力）
  const mem = readMemory();
  const patterns = recurringPatterns(mem, String(project));
  const risky = riskyFiles(mem, String(project)).filter((f) => changedPaths.includes(f.file));
  if (patterns.length > 0) console.error(`[review] 记忆库：${patterns.length} 个惯犯模式注入提示词`);
  if (risky.length > 0) console.error(`[review] 热力：本次涉及 ${risky.length} 个高风险文件（${risky.map((f) => f.file).join(", ")}）`);
  const userPrompt = reviewUserPrompt(mr, files, prevTitles, patterns, risky);
  const perSkill = await Promise.all(
    skills.map(async (skill) => {
      try {
        const out = await chat(cfg.ai, reviewSystemPrompt(cfg, skill), userPrompt, { model: skill.model });
        const arr = extractJson<Omit<Finding, "skill">[]>(out);
        return arr.map((f) => ({ ...f, skill: skill.name }));
      } catch (err) {
        console.error(`[review] skill ${skill.name} 失败：${(err as Error).message}`);
        return [];
      }
    }),
  );

  // 2. sanitize + dedupe (same file+line keeps the most severe)
  const addedByFile = new Map(files.map((f) => [f.path, addedLineSet(f)]));
  let findings = perSkill.flat().filter((f) => {
    if (!f.file || !f.title || SEV_ORDER[f.severity as Severity] === undefined) return false;
    if (typeof f.confidence !== "number") f.confidence = 60;
    const added = addedByFile.get(f.file);
    if (!added || f.line === null || !added.has(f.line)) f.line = null; // demote to summary-only
    return true;
  });
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.title.slice(0, 20)}`;
    const prev = seen.get(key);
    if (!prev || SEV_ORDER[f.severity] < SEV_ORDER[prev.severity]) seen.set(key, f);
  }
  findings = [...seen.values()];
  const beforeFilter = findings.length;

  // 3. confidence floor + rebuttal verification
  findings = findings.filter((f) => f.confidence >= cfg.review.minConfidence);
  if (cfg.review.verify && findings.length > 0) {
    console.error(`[review] 反驳验证 ${findings.length} 条发现 ...`);
    const checked = await Promise.all(
      findings.map(async (f) => {
        try {
          const fileDiff = files.find((x) => x.path === f.file);
          const ctx = fileDiff ? annotate(fileDiff).slice(0, 6000) : "";
          const out = await chat(
            cfg.ai, VERIFY_SYSTEM,
            `## 发现\n${JSON.stringify(f, null, 2)}\n\n## 相关 diff\n${ctx}`,
            { model: cfg.ai.lightModel, maxTokens: 500 },
          );
          const v = extractJson<{ refuted: boolean; reason: string }>(out);
          if (v.refuted) console.error(`[verify] 已过滤「${f.title}」：${v.reason}`);
          return v.refuted ? null : f;
        } catch {
          return f; // verification failure keeps the finding
        }
      }),
    );
    findings = checked.filter((f): f is Finding => f !== null);
  }
  findings.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || b.confidence - a.confidence);
  const filtered = beforeFilter - findings.length;

  // 4. verdict + summary
  const gate = cfg.review.severityGate;
  const verdict: ReviewResult["verdict"] =
    gate !== "off" && findings.some((f) => SEV_ORDER[f.severity] <= SEV_ORDER[gate])
      ? "needs-work" : "approve";
  const summary = buildSummary(findings, filtered, skipped, truncated, verdict, cfg, mr, incremental);

  // 5. post back to GitLab
  if (!opts.dryRun) {
    const inline = findings.filter((f) => f.line !== null).slice(0, cfg.review.maxComments);
    for (const f of inline) {
      const body = formatFinding(f);
      try {
        await gl.postInlineDiscussion(project, iid, mr, f.file, f.line!, body);
      } catch {
        await gl.postMrNote(project, iid, `**${f.file}:${f.line}**\n\n${body}`);
      }
    }
    await gl.postMrNote(project, iid, summary);
    console.error(`[review] 已发布 ${inline.length} 条行内评论 + 1 条总评`);
  }

  const counts = { critical: 0, serious: 0, suggestion: 0 } as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;
  recordReview({
    ts: new Date().toISOString(),
    project: String(project), iid: mr.iid, title: mr.title,
    verdict, ...counts, filtered,
    incremental, dryRun: !!opts.dryRun,
    durationMs: Date.now() - t0, model: cfg.ai.model,
  });

  if (!opts.dryRun) {
    // 沉淀到记忆库（只记正式发布的发现，dry-run 不算）
    recordMemory(findings.map((f) => ({
      ts: new Date().toISOString(),
      project: String(project), iid: mr.iid,
      file: f.file, severity: f.severity, title: f.title, skill: f.skill,
    })));
    await notifyReview(cfg, { project: String(project), mr, verdict, counts, incremental });
  }

  return { mr, findings, filtered, skippedFiles: skipped, verdict, summary, incremental };
}

/**
 * 效果回放：单个 skill 对某个 MR 试跑，只返回发现，不发布任何评论、不写记录。
 * Skill 编辑页用它在规则上线前预览产出。
 */
export async function testSkillOnMr(
  cfg: Config,
  project: string | number,
  iid: number,
  skill: Skill,
): Promise<{ findings: Finding[]; fileCount: number }> {
  const gl = new GitLab(cfg);
  const mr = await gl.getMr(project, iid);
  cfg = (await resolveProjectConfig(cfg, gl, project, mr.target_branch)).cfg;
  const changes = await gl.getMrChanges(project, iid);
  const { files } = prepareChanges(changes, cfg.review.ignorePaths, cfg.review.maxDiffLines);
  if (files.length === 0) return { findings: [], fileCount: 0 };
  const out = await chat(cfg.ai, reviewSystemPrompt(cfg, skill), reviewUserPrompt(mr, files, []), {
    model: skill.model,
  });
  const arr = extractJson<Omit<Finding, "skill">[]>(out);
  return {
    findings: arr
      .filter((f) => f.file && f.title)
      .map((f) => ({ ...f, skill: skill.name })),
    fileCount: files.length,
  };
}

/* ---------------- formatting ---------------- */

function formatFinding(f: Finding): string {
  const fix = f.fix ? `\n\n建议修复：\n\`\`\`\n${f.fix}\n\`\`\`` : "";
  return `${SEV_LABEL[f.severity]} **${f.title}**（\`${f.skill}\` · 置信度 ${f.confidence}%）

${f.detail}${fix}

---
*mergelens AI 审查 · 认为误报请回复 👎，将用于规则调优*`;
}

function buildSummary(
  findings: Finding[], filtered: number, skipped: string[],
  truncated: boolean, verdict: "approve" | "needs-work", cfg: Config,
  mr: MrInfo, incremental: boolean,
): string {
  const counts = { critical: 0, serious: 0, suggestion: 0 } as Record<Severity, number>;
  for (const f of findings) counts[f.severity]++;
  const head = verdict === "needs-work"
    ? `## 🔍 mergelens 审查结果：⛔ 建议修复后合并`
    : `## 🔍 mergelens 审查结果：✅ 未发现阻塞问题`;
  const lines = [
    reviewMarker(mr.sha),
    head + (incremental ? "（增量：仅新推送的改动）" : ""), "",
    `共 ${findings.length} 条发现：🔴 ${counts.critical} 高危 · 🟠 ${counts.serious} 严重 · 🟡 ${counts.suggestion} 建议` +
      (filtered > 0 ? `（另有 ${filtered} 条低置信度发现已自动过滤）` : ""),
  ];
  if (findings.length > 0) {
    lines.push("", "| 严重度 | 位置 | 问题 | 维度 |", "|---|---|---|---|");
    for (const f of findings) {
      lines.push(`| ${SEV_LABEL[f.severity]} | \`${f.file}${f.line ? ":" + f.line : ""}\` | ${f.title} | ${f.skill} |`);
    }
  }
  if (skipped.length > 0) {
    lines.push("", `> 跳过 ${skipped.length} 个文件（忽略规则${truncated ? "或超出 diff 上限" : ""}）：${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? " ..." : ""}`);
  }
  lines.push("", `*模型 ${cfg.ai.model} · 门禁 ${cfg.review.severityGate} · [配置说明](.ai-review.yml)*`);
  return lines.join("\n");
}

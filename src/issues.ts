import type { Config, Finding, GitLabIssue, MrInfo } from "./types.js";
import { GitLab } from "./gitlab.js";
import { chat, extractJson } from "./ai.js";

const SEV_LABELS: Record<string, string[]> = {
  critical: ["ai-found", "severity::critical"],
  serious: ["ai-found", "severity::serious"],
  suggestion: ["ai-found"],
};

/**
 * Create an issue from a review finding — with a duplicate check first.
 * Returns the created issue, or the existing duplicate if one was found.
 */
export async function createIssueFromFinding(
  cfg: Config,
  project: string | number,
  finding: Finding,
  mr?: MrInfo,
): Promise<{ issue: GitLabIssue; duplicate: boolean }> {
  const gl = new GitLab(cfg);

  // duplicate check: search open issues by title keywords, let the light model judge
  const keywords = finding.title.split(/[\s,，。:：]+/).filter((w) => w.length >= 2).slice(0, 4).join(" ");
  const candidates = keywords ? await gl.listIssues(project, { search: keywords }) : [];
  if (candidates.length > 0) {
    try {
      const out = await chat(
        cfg.ai,
        `判断新问题是否与已有 issue 重复。严格输出 JSON：{"duplicate_iid": 数字或null}`,
        `新问题：${finding.title}\n${finding.detail}\n\n已有 issues：\n` +
          candidates.map((i) => `#${i.iid} ${i.title}`).join("\n"),
        { model: cfg.ai.lightModel, maxTokens: 200 },
      );
      const { duplicate_iid } = extractJson<{ duplicate_iid: number | null }>(out);
      const dup = candidates.find((i) => i.iid === duplicate_iid);
      if (dup) return { issue: dup, duplicate: true };
    } catch {
      /* duplicate check is best-effort */
    }
  }

  const loc = finding.line ? `${finding.file}:${finding.line}` : finding.file;
  const description = [
    `> 由 mergelens 从代码审查发现自动创建${mr ? `，来源 ${mr.web_url}` : ""}`,
    "",
    `**位置**：\`${loc}\``,
    `**严重度**：${finding.severity} · 置信度 ${finding.confidence}% · 审查维度 \`${finding.skill}\``,
    "",
    "## 问题描述",
    finding.detail,
    ...(finding.fix ? ["", "## 建议修复", "```", finding.fix, "```"] : []),
  ].join("\n");

  const issue = await gl.createIssue(project, {
    title: finding.title,
    description,
    labels: SEV_LABELS[finding.severity] ?? ["ai-found"],
  });
  return { issue, duplicate: false };
}

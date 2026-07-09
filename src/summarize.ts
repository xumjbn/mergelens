import type { Config } from "./types.js";
import { GitLab } from "./gitlab.js";
import { chat } from "./ai.js";
import { annotate, prepareChanges } from "./diff.js";

const MARKER = "<!-- mergelens:summary -->";

/**
 * 为 MR 生成「改了什么 / 为什么 / 影响面」摘要。
 * 默认发布为 MR 评论；--update-desc 时追加到 MR 描述末尾。
 */
export async function summarizeMr(
  cfg: Config,
  project: string | number,
  iid: number,
  opts: { dryRun?: boolean; updateDescription?: boolean } = {},
): Promise<string> {
  const gl = new GitLab(cfg);
  console.error(`[summarize] 拉取 MR ${project}!${iid} ...`);
  const mr = await gl.getMr(project, iid);
  const changes = await gl.getMrChanges(project, iid);
  const { files, skipped } = prepareChanges(changes, cfg.review.ignorePaths, cfg.review.maxDiffLines);
  if (files.length === 0) throw new Error("没有可总结的文本改动");

  const system = `你是资深工程师，为一个 GitLab Merge Request 写审阅前摘要，给 reviewer 三十秒建立全貌。
用${cfg.review.language}输出 markdown，结构固定为三节：
## 改了什么 —— 按模块分点，每点一句话，具体到行为变化而不是文件名罗列
## 为什么 —— 从 MR 标题/描述/代码推断动机；推断的内容标注（推测）
## 影响面与风险 —— 波及的调用方、行为变化、部署注意事项；没有就写"无明显风险"
总长度不超过 300 字。不要复述 diff，不要客套。`;

  const user = `MR 标题：${mr.title}
MR 描述：${(mr.description || "（无）").slice(0, 1500)}
分支：${mr.source_branch} → ${mr.target_branch}
${skipped.length > 0 ? `（另有 ${skipped.length} 个文件被忽略规则跳过）` : ""}

## Diff
${files.map(annotate).join("\n\n")}`;

  const summary = (await chat(cfg.ai, system, user, {
    model: cfg.ai.lightModel, // 摘要用轻量模型即可
    maxTokens: 1500,
  })).trim();

  const body = `${MARKER}\n## 📝 MR 摘要（mergelens）\n\n${summary}`;

  if (opts.dryRun) return summary;

  if (opts.updateDescription) {
    // 已有摘要则替换，避免重复追加
    const desc = mr.description ?? "";
    const idx = desc.indexOf(MARKER);
    const base = idx >= 0 ? desc.slice(0, idx).trimEnd() : desc;
    await gl.updateMrDescription(project, iid, `${base}\n\n${body}`);
    console.error("[summarize] 已写入 MR 描述");
  } else {
    await gl.postMrNote(project, iid, body);
    console.error("[summarize] 已发布为 MR 评论");
  }
  return summary;
}

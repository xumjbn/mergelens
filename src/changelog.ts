import type { Config } from "./types.js";
import { GitLab } from "./gitlab.js";
import { chat } from "./ai.js";

/** 从最近已合并的 MR 生成发布说明（markdown，输出到 stdout，由调用方决定去处）。 */
export async function generateChangelog(
  cfg: Config,
  project: string | number,
  opts: { days?: number; targetBranch?: string } = {},
): Promise<string> {
  const days = opts.days ?? 14;
  const gl = new GitLab(cfg);
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  const mrs = await gl.listMergedMrs(project, {
    targetBranch: opts.targetBranch,
    updatedAfter: since,
  });
  const merged = mrs.filter((m) => m.merged_at && m.merged_at >= since);
  if (merged.length === 0) {
    return `最近 ${days} 天${opts.targetBranch ? `（目标分支 ${opts.targetBranch}）` : ""}没有已合并的 MR。`;
  }

  const system = `你是发布说明（changelog）撰写者。根据已合并的 MR 列表生成面向用户的发布说明。
要求：
- 用${cfg.review.language}，markdown 格式
- 按类型分组：✨ 新功能 / 🐛 修复 / 🔧 优化与其他（从标题和描述推断类型；空组省略）
- 每条一行：一句话说清对使用者的影响（改写 MR 标题，不要照抄工程术语），行尾附 (!MR号)
- 多个 MR 属于同一件事时合并成一条
- 开头一行概述本次发布的重点，结尾一行统计（共 N 个 MR，M 位贡献者）
- 不要编造列表里不存在的内容`;

  const user = merged
    .map((m) => `!${m.iid} ${m.title}\n  作者:${m.author.username} 合并:${m.merged_at.slice(0, 10)} 标签:[${m.labels.join(",")}]\n  ${(m.description || "").slice(0, 200).replace(/\n/g, " ")}`)
    .join("\n");

  const out = await chat(cfg.ai, system, `已合并 MR 列表（最近 ${days} 天）：\n\n${user}`, {
    model: cfg.ai.lightModel,
    maxTokens: 2500,
  });
  return out.trim();
}

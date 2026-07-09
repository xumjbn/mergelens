import type { Config } from "./types.js";
import { GitLab } from "./gitlab.js";
import { chat } from "./ai.js";
import { annotate, prepareChanges } from "./diff.js";
import { resolveProjectConfig } from "./config.js";
import { reviewMr } from "./review/pipeline.js";
import { summarizeMr } from "./summarize.js";

/** 去掉 @bot 前缀，留下真正的问题。 */
export function stripMention(note: string, botUsername: string): string {
  return note.replaceAll(`@${botUsername}`, "").trim();
}

/**
 * 处理评论区 @机器人：
 * - 「重新审查」→ 全量重审
 * - 「摘要/总结」→ 生成 MR 摘要
 * - 其他 → 带 MR diff 上下文的问答（在原讨论串里回复）
 */
export async function answerMention(
  cfg: Config,
  project: string | number,
  iid: number,
  opts: { question: string; author: string; discussionId?: string },
): Promise<void> {
  const gl = new GitLab(cfg);
  const reply = (body: string): Promise<unknown> =>
    opts.discussionId
      ? gl.postDiscussionReply(project, iid, opts.discussionId, body).catch(() => gl.postMrNote(project, iid, body))
      : gl.postMrNote(project, iid, body);

  const q = opts.question;

  // 命令：重新审查
  if (/重新审查|重审|re-?review/i.test(q)) {
    await reply(`收到 @${opts.author}，开始全量重审……结果稍后以新评论发布。`);
    await reviewMr(cfg, project, iid, { fullReview: true });
    return;
  }
  // 命令：摘要
  if (/摘要|总结|summar/i.test(q)) {
    await summarizeMr(cfg, project, iid, {});
    return;
  }

  // 问答：带 MR 上下文
  const mr = await gl.getMr(project, iid);
  cfg = (await resolveProjectConfig(cfg, gl, project, mr.target_branch)).cfg;
  const changes = await gl.getMrChanges(project, iid);
  const { files } = prepareChanges(changes, cfg.review.ignorePaths, Math.min(cfg.review.maxDiffLines, 1500));

  const system = `你是 mergelens，一个 AI 代码审查机器人。开发者在 GitLab MR 的评论区 @ 了你。
基于下面提供的 MR diff 和信息回答问题。规则：
- 用${cfg.review.language}回复，直接、简短，markdown 格式，不要客套开场白
- 如果开发者对你此前的审查发现提出异议：重新评估。证据站得住就有理有据地坚持；确属误报就明确承认（「你说得对，这条是误报」）并简述原因
- 如果被要求提供修复代码，给出可直接粘贴的代码块
- 超出这个 MR 范围的问题，说明你只了解本 MR 的改动`;

  const user = `## MR
标题：${mr.title}
描述：${(mr.description || "（无）").slice(0, 1000)}
分支：${mr.source_branch} → ${mr.target_branch}

## Diff（行首数字 = 新文件行号）
${files.map(annotate).join("\n\n").slice(0, 40000)}

## 开发者 @${opts.author} 的留言
${q}`;

  const answer = await chat(cfg.ai, system, user, { maxTokens: 2000 });
  await reply(answer.trim());
  console.error(`[assistant] 已回复 ${project}!${iid} 中 @${opts.author} 的提问`);
}

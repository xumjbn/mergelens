import type { Config } from "./types.js";
import { GitLab } from "./gitlab.js";
import { chat } from "./ai.js";
import { annotate, prepareChanges, redact } from "./diff.js";
import { resolveProjectConfig } from "./config.js";
import { reviewMr } from "./review/pipeline.js";
import { summarizeMr } from "./summarize.js";
import { createIssueFromNoteBody } from "./issues.js";

/** 去掉 @bot / 触发词，留下真正的问题。 */
export function stripMention(note: string, mentions: string[]): string {
  let out = note;
  for (const m of mentions) {
    if (m) out = out.split(m).join("");
  }
  return out.trim();
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
  // 命令：转 Issue（在发现的讨论串里 @ai 转issue → 把该发现转为 Issue，带判重）
  if (/转\s*issue|提\s*issue|create\s*issue/i.test(q)) {
    let body = q;
    if (opts.discussionId) {
      try {
        const disc = (await gl.listDiscussions(project, iid)).find((d) => d.id === opts.discussionId);
        if (disc?.notes[0]) body = disc.notes[0].body;
      } catch { /* 取不到讨论串就用留言本身 */ }
    }
    const mrInfo = await gl.getMr(project, iid);
    const { issue, duplicate } = await createIssueFromNoteBody(cfg, project, body, mrInfo.web_url);
    await reply(duplicate
      ? `已有相似 Issue #${issue.iid}，未重复创建：${issue.web_url}`
      : `已创建 Issue #${issue.iid}：${issue.web_url}`);
    return;
  }

  // 问答：带 MR 上下文 + 所在讨论串历史（追问不丢上下文）
  const mr = await gl.getMr(project, iid);
  cfg = (await resolveProjectConfig(cfg, gl, project, mr.target_branch)).cfg;
  const changes = await gl.getMrChanges(project, iid);
  const { files } = prepareChanges(changes, cfg.review.ignorePaths, Math.min(cfg.review.maxDiffLines, 1500));
  let thread = "";
  if (opts.discussionId) {
    try {
      const disc = (await gl.listDiscussions(project, iid)).find((d) => d.id === opts.discussionId);
      if (disc && disc.notes.length > 1) {
        thread = disc.notes.slice(-10)
          .map((n) => `@${n.author.username}：${n.body.slice(0, 600)}`)
          .join("\n---\n");
      }
    } catch { /* 线程历史尽力而为 */ }
  }

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
${redact(files.map(annotate).join("\n\n").slice(0, 40000), cfg.review.redactPatterns)}
${thread ? `\n## 所在讨论串的历史对话（按时间顺序）\n${thread}\n` : ""}
## 开发者 @${opts.author} 的最新留言
${q}`;

  const answer = await chat(cfg.ai, system, user, { maxTokens: 2000 });
  await reply(answer.trim());
  console.error(`[assistant] 已回复 ${project}!${iid} 中 @${opts.author} 的提问`);
}

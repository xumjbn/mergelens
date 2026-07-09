import type { Config } from "./types.js";
import { GitLab } from "./gitlab.js";
import { recordFeedback, recordSkillOutcomes, type FeedbackRecord, type SkillOutcome } from "./store.js";

/** 行内评论格式为 `**标题**（\`skill\` · 置信度 N%）`，从评论文本反解 skill 名。 */
export function parseSkillFromNote(body: string): string | null {
  const m = /（`([\w-]+)`\s*·\s*置信度/.exec(body);
  return m ? m[1] : null;
}

/**
 * 结算一个 MR 的审查反馈（通常在 MR 合并时自动触发）：
 * - bot 发起的 resolvable 讨论被 resolve → 视为「采纳」
 * - 讨论首条评论上的 👍/👎 表情 → 显式反馈
 */
export async function collectFeedback(
  cfg: Config,
  project: string | number,
  iid: number,
): Promise<FeedbackRecord | null> {
  const gl = new GitLab(cfg);
  const me = (await gl.getCurrentUser()).username;
  const discussions = await gl.listDiscussions(project, iid);

  const botDiscussions = discussions.filter(
    (d) => d.notes[0]?.author?.username === me && d.notes[0]?.resolvable,
  );
  if (botDiscussions.length === 0) return null;

  const resolved = botDiscussions.filter((d) => d.notes[0].resolved).length;
  let up = 0;
  let down = 0;
  const outcomes: SkillOutcome[] = [];
  // 表情要逐条 note 拉，限制在前 20 条内，避免大 MR 打爆 API
  for (const [i, d] of botDiscussions.entries()) {
    let noteUp = 0;
    let noteDown = 0;
    if (i < 20) {
      try {
        const awards = await gl.getNoteAwards(project, iid, d.notes[0].id);
        noteUp = awards.filter((a) => a.name === "thumbsup").length;
        noteDown = awards.filter((a) => a.name === "thumbsdown").length;
      } catch {
        /* 表情拉取失败不影响结算 */
      }
    }
    up += noteUp;
    down += noteDown;
    const skill = parseSkillFromNote(d.notes[0].body);
    if (skill) {
      outcomes.push({
        ts: new Date().toISOString(),
        project: String(project), iid, skill,
        resolved: !!d.notes[0].resolved, up: noteUp, down: noteDown,
      });
    }
  }
  recordSkillOutcomes(outcomes); // 按 skill 归因，供自动调权

  const rec: FeedbackRecord = {
    ts: new Date().toISOString(),
    project: String(project),
    iid,
    findings: botDiscussions.length,
    resolved,
    up,
    down,
  };
  recordFeedback(rec);
  console.error(
    `[feedback] ${project}!${iid} 结算：${botDiscussions.length} 条发现，采纳 ${resolved}，👍${up} 👎${down}`,
  );
  return rec;
}

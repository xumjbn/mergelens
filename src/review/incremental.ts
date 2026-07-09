/**
 * 增量审查支持：通过总评里埋的 HTML 注释标记记住「上次审到哪个 commit」，
 * push 新提交后只审 last_sha..head 的增量 diff，并把旧发现喂给模型避免重复。
 */

const MARKER_RE = /<!-- mergelens:review sha=([0-9a-f]{6,64}) -->/g;

export function reviewMarker(sha: string): string {
  return `<!-- mergelens:review sha=${sha} -->`;
}

/** 从本 bot 历史评论中取最后一次审查的 head sha（notes 按时间正序传入）。 */
export function lastReviewedSha(noteBodies: string[]): string | null {
  let last: string | null = null;
  for (const body of noteBodies) {
    for (const m of body.matchAll(MARKER_RE)) last = m[1];
  }
  return last;
}

/**
 * 提取历史评论中的发现标题（加粗段），用于提示模型「这些已经说过了」。
 * 只认「发现格式」的评论（含 置信度 N%）——bot 的对话回复里的加粗不算，避免污染。
 */
export function previousFindingTitles(noteBodies: string[]): string[] {
  const titles = new Set<string>();
  for (const body of noteBodies) {
    if (!/置信度\s*\d+%/.test(body)) continue;
    for (const m of body.matchAll(/\*\*(.{4,120}?)\*\*/g)) {
      titles.add(m[1].trim());
    }
  }
  return [...titles];
}

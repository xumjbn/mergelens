import type { Config, GitLabIssue, MrChange, MrInfo } from "./types.js";

export class GitLab {
  private base: string;
  private token: string;

  constructor(cfg: Config) {
    this.base = cfg.gitlabUrl + "/api/v4";
    this.token = cfg.gitlabToken;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        "PRIVATE-TOKEN": this.token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new Error(`GitLab ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return res.json() as Promise<T>;
  }

  private proj(project: string | number): string {
    return encodeURIComponent(String(project));
  }

  /** 项目信息（拿默认分支用）。 */
  getProject(project: string | number): Promise<{ default_branch: string; path_with_namespace: string }> {
    return this.req("GET", `/projects/${this.proj(project)}`);
  }

  /** 创建/更新仓库单文件（页面「提交配置到仓库」用）。 */
  async commitFile(
    project: string | number,
    branch: string,
    filePath: string,
    content: string,
    message: string,
  ): Promise<{ id: string }> {
    let exists = true;
    try {
      await this.getRawFile(project, filePath, branch);
    } catch {
      exists = false;
    }
    return this.req("POST", `/projects/${this.proj(project)}/repository/commits`, {
      branch,
      commit_message: message,
      actions: [{ action: exists ? "update" : "create", file_path: filePath, content }],
    });
  }

  /* ---------------- Repository files ---------------- */

  /** 仓库单文件原文（404 时抛错）。 */
  async getRawFile(project: string | number, path: string, ref: string): Promise<string> {
    const url = `${this.base}/projects/${this.proj(project)}/repository/files/${encodeURIComponent(path)}/raw?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, { headers: { "PRIVATE-TOKEN": this.token } });
    if (!res.ok) throw new Error(`GitLab GET ${path} → ${res.status}`);
    return res.text();
  }

  /** 仓库目录列表（目录不存在时返回空数组）。 */
  async listTree(project: string | number, path: string, ref: string): Promise<Array<{ name: string; path: string; type: string }>> {
    try {
      return await this.req(
        "GET",
        `/projects/${this.proj(project)}/repository/tree?path=${encodeURIComponent(path)}&ref=${encodeURIComponent(ref)}&per_page=100`,
      );
    } catch {
      return [];
    }
  }

  /** 验证 token：返回当前认证用户。 */
  getCurrentUser(): Promise<{ username: string; name: string }> {
    return this.req("GET", "/user");
  }

  /* ---------------- MR ---------------- */

  getMr(project: string | number, iid: number): Promise<MrInfo> {
    return this.req("GET", `/projects/${this.proj(project)}/merge_requests/${iid}`);
  }

  async getMrChanges(project: string | number, iid: number): Promise<MrChange[]> {
    const data = await this.req<{ changes: MrChange[] }>(
      "GET",
      `/projects/${this.proj(project)}/merge_requests/${iid}/changes?access_raw_diffs=true`,
    );
    return data.changes;
  }

  /** Plain (non-positioned) note on the MR — used for the summary. */
  postMrNote(project: string | number, iid: number, body: string): Promise<unknown> {
    return this.req("POST", `/projects/${this.proj(project)}/merge_requests/${iid}/notes`, { body });
  }

  /** Inline discussion anchored to a NEW-file line. Falls back by throwing; caller decides. */
  postInlineDiscussion(
    project: string | number,
    iid: number,
    mr: MrInfo,
    filePath: string,
    newLine: number,
    body: string,
  ): Promise<unknown> {
    return this.req("POST", `/projects/${this.proj(project)}/merge_requests/${iid}/discussions`, {
      body,
      position: {
        position_type: "text",
        base_sha: mr.diff_refs.base_sha,
        head_sha: mr.diff_refs.head_sha,
        start_sha: mr.diff_refs.start_sha,
        new_path: filePath,
        new_line: newLine,
      },
    });
  }

  updateMrDescription(project: string | number, iid: number, description: string): Promise<unknown> {
    return this.req("PUT", `/projects/${this.proj(project)}/merge_requests/${iid}`, { description });
  }

  /** MR 全部评论（时间正序），用于增量审查定位上次审到的 sha。 */
  getMrNotes(project: string | number, iid: number): Promise<Array<{ body: string; author: { username: string } }>> {
    return this.req(
      "GET",
      `/projects/${this.proj(project)}/merge_requests/${iid}/notes?per_page=100&order_by=created_at&sort=asc`,
    );
  }

  /** 两个 commit 之间的 diff（增量审查用），返回结构与 MR changes 相同。 */
  compare(project: string | number, from: string, to: string): Promise<{ diffs: MrChange[] }> {
    return this.req(
      "GET",
      `/projects/${this.proj(project)}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
  }

  /** MR 全部讨论串（含每条 note 的 resolved 状态），采纳率统计用。 */
  listDiscussions(project: string | number, iid: number): Promise<Array<{
    id: string;
    notes: Array<{ id: number; body: string; author: { username: string }; resolvable: boolean; resolved?: boolean }>;
  }>> {
    return this.req("GET", `/projects/${this.proj(project)}/merge_requests/${iid}/discussions?per_page=100`);
  }

  /** 在已有讨论串里回复（@机器人 对话用）。 */
  postDiscussionReply(project: string | number, iid: number, discussionId: string, body: string): Promise<unknown> {
    return this.req(
      "POST",
      `/projects/${this.proj(project)}/merge_requests/${iid}/discussions/${encodeURIComponent(discussionId)}/notes`,
      { body },
    );
  }

  /** 某条评论上的表情（👍/👎 反馈）。 */
  getNoteAwards(project: string | number, iid: number, noteId: number): Promise<Array<{ name: string }>> {
    return this.req("GET", `/projects/${this.proj(project)}/merge_requests/${iid}/notes/${noteId}/award_emoji`);
  }

  /* ---------------- Issues ---------------- */

  createIssue(
    project: string | number,
    opts: { title: string; description: string; labels?: string[] },
  ): Promise<GitLabIssue> {
    return this.req("POST", `/projects/${this.proj(project)}/issues`, {
      title: opts.title,
      description: opts.description,
      labels: opts.labels?.join(","),
    });
  }

  listIssues(
    project: string | number,
    opts: { search?: string; state?: "opened" | "closed" | "all"; labels?: string } = {},
  ): Promise<GitLabIssue[]> {
    const q = new URLSearchParams({ per_page: "50" });
    if (opts.search) q.set("search", opts.search);
    q.set("state", opts.state ?? "opened");
    if (opts.labels) q.set("labels", opts.labels);
    return this.req("GET", `/projects/${this.proj(project)}/issues?${q}`);
  }
}

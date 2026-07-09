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

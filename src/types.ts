export type Severity = "critical" | "serious" | "suggestion";

export interface Finding {
  file: string;
  /** line number in the NEW file version (as annotated in the prompt diff) */
  line: number | null;
  severity: Severity;
  title: string;
  detail: string;
  /** 0-100 */
  confidence: number;
  /** optional suggested fix (diff or code snippet) */
  fix?: string;
  /** which skill produced it */
  skill: string;
}

export interface Skill {
  name: string;
  /** glob patterns; finding files must match at least one. empty = all files */
  triggers: string[];
  severityWeight: number;
  /** per-skill model override (task key or raw model id) */
  model?: string;
  body: string;
}

export interface AiConfig {
  provider: "anthropic" | "openai" | "deepseek" | "ollama";
  model: string;
  fallbackModel?: string;
  /** cheap model for summaries / low-value tasks */
  lightModel?: string;
  baseUrl?: string;
  temperature: number;
  maxTokens: number;
}

export interface ReviewConfig {
  maxDiffLines: number;
  ignorePaths: string[];
  /** post at most N inline comments per MR; rest folded into summary */
  maxComments: number;
  /** findings at/above this severity make the summary verdict "needs work" */
  severityGate: Severity | "off";
  /** run the rebuttal-verification pass */
  verify: boolean;
  /** re-review only pushes since the last reviewed sha, skip already-reviewed shas */
  incremental: boolean;
  /** drop findings below this confidence (0-100) */
  minConfidence: number;
  language: string;
  skillsDir: string;
  enabledSkills: string[] | "all";
}

export interface Config {
  gitlabUrl: string;
  gitlabToken: string;
  webhookSecret?: string;
  ai: AiConfig;
  review: ReviewConfig;
}

/* ---------------- GitLab API shapes (subset) ---------------- */

export interface MrInfo {
  iid: number;
  title: string;
  description: string;
  author: { username: string };
  source_branch: string;
  target_branch: string;
  sha: string;
  diff_refs: { base_sha: string; head_sha: string; start_sha: string };
  web_url: string;
}

export interface MrChange {
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
  diff: string;
}

export interface GitLabIssue {
  iid: number;
  title: string;
  description: string;
  state: string;
  labels: string[];
  web_url: string;
}

/* ---------------- diff parsing ---------------- */

export interface DiffLine {
  type: "add" | "del" | "ctx";
  oldLine: number | null;
  newLine: number | null;
  text: string;
}

export interface ParsedFile {
  path: string;
  lines: DiffLine[];
  addedCount: number;
  deletedCount: number;
}

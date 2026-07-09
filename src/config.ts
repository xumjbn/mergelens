import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import type { Config, Severity } from "./types.js";

const DEFAULTS = {
  ai: {
    provider: "anthropic" as const,
    model: "claude-sonnet-5",
    temperature: 0.2,
    maxTokens: 4096,
  },
  review: {
    maxDiffLines: 3000,
    ignorePaths: ["*.lock", "package-lock.json", "dist/**", "*.min.js", "vendor/**"],
    maxComments: 8,
    severityGate: "serious" as Severity,
    verify: true,
    incremental: true,
    minConfidence: 70,
    language: "简体中文",
    skillsDir: "skills",
    enabledSkills: "all" as const,
  },
};

/**
 * Load config: .ai-review.yml (searched in cwd, or MERGELENS_CONFIG path)
 * merged over defaults; secrets always come from environment variables.
 */
export function loadConfig(configPath?: string): Config {
  const candidates = [
    configPath,
    process.env.MERGELENS_CONFIG,
    resolve(process.cwd(), ".ai-review.yml"),
    resolve(process.cwd(), ".ai-review.yaml"),
  ].filter(Boolean) as string[];

  let fileCfg: any = {};
  for (const p of candidates) {
    if (existsSync(p)) {
      fileCfg = YAML.parse(readFileSync(p, "utf8")) ?? {};
      break;
    }
  }

  const gitlabUrl = process.env.GITLAB_URL ?? fileCfg.gitlab?.url ?? "https://gitlab.com";
  const gitlabToken = process.env.GITLAB_TOKEN ?? "";

  const cfg: Config = {
    gitlabUrl: gitlabUrl.replace(/\/+$/, ""),
    gitlabToken,
    webhookSecret: process.env.WEBHOOK_SECRET,
    ai: {
      ...DEFAULTS.ai,
      ...fileCfg.ai,
    },
    review: {
      ...DEFAULTS.review,
      ...fileCfg.review,
      // yaml `ignore_paths` / camelCase both accepted
      ignorePaths: fileCfg.review?.ignore_paths ?? fileCfg.review?.ignorePaths ?? DEFAULTS.review.ignorePaths,
      maxDiffLines: fileCfg.review?.max_diff_lines ?? fileCfg.review?.maxDiffLines ?? DEFAULTS.review.maxDiffLines,
      maxComments: fileCfg.review?.max_comments ?? fileCfg.review?.maxComments ?? DEFAULTS.review.maxComments,
      severityGate: fileCfg.review?.severity_gate ?? fileCfg.review?.severityGate ?? DEFAULTS.review.severityGate,
      minConfidence: fileCfg.review?.min_confidence ?? fileCfg.review?.minConfidence ?? DEFAULTS.review.minConfidence,
      incremental: fileCfg.review?.incremental ?? DEFAULTS.review.incremental,
      skillsDir: fileCfg.review?.skills_dir ?? fileCfg.review?.skillsDir ?? DEFAULTS.review.skillsDir,
      enabledSkills: fileCfg.skills?.enabled ?? DEFAULTS.review.enabledSkills,
    },
    notify: {
      on: fileCfg.notify?.on ?? "needs-work",
    },
  };

  if (fileCfg.ai?.fallback) cfg.ai.fallbackModel = fileCfg.ai.fallback;
  if (fileCfg.ai?.light_model) cfg.ai.lightModel = fileCfg.ai.light_model;
  if (fileCfg.ai?.base_url) cfg.ai.baseUrl = fileCfg.ai.base_url;

  return cfg;
}

export function requireToken(cfg: Config): void {
  if (!cfg.gitlabToken) {
    throw new Error("缺少 GITLAB_TOKEN 环境变量（GitLab personal/project access token，需 api 权限）");
  }
}

export function requireAiKey(cfg: Config): void {
  const need =
    cfg.ai.provider === "anthropic" ? "ANTHROPIC_API_KEY"
    : cfg.ai.provider === "openai" ? "OPENAI_API_KEY"
    : cfg.ai.provider === "deepseek" ? "DEEPSEEK_API_KEY"
    : null; // ollama needs no key
  if (need && !process.env[need]) {
    throw new Error(`缺少 ${need} 环境变量（provider=${cfg.ai.provider}）`);
  }
}

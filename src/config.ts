import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import type { Config, Severity } from "./types.js";
import type { GitLab } from "./gitlab.js";

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
    redactPatterns: [] as string[],
    autoSummaryLines: 400,
    vote: "off" as const,
    dailyTokenBudget: 0,
  },
  notify: { on: "needs-work" as const },
  assistant: { trigger: "@ai" },
};

/** 把一份 .ai-review.yml 的内容合并到 base 之上（两级继承的通用实现）。 */
export function mergeFileConfig(base: Config, fileCfg: any): Config {
  const ai = fileCfg?.ai ?? {};
  const r = fileCfg?.review ?? {};
  return {
    ...base,
    ai: {
      ...base.ai,
      provider: ai.provider ?? base.ai.provider,
      model: ai.model ?? base.ai.model,
      temperature: ai.temperature ?? base.ai.temperature,
      maxTokens: ai.max_tokens ?? ai.maxTokens ?? base.ai.maxTokens,
      fallbackModel: ai.fallback ?? base.ai.fallbackModel,
      lightModel: ai.light_model ?? base.ai.lightModel,
      baseUrl: ai.base_url ?? base.ai.baseUrl,
    },
    review: {
      ...base.review,
      maxDiffLines: r.max_diff_lines ?? r.maxDiffLines ?? base.review.maxDiffLines,
      ignorePaths: r.ignore_paths ?? r.ignorePaths ?? base.review.ignorePaths,
      maxComments: r.max_comments ?? r.maxComments ?? base.review.maxComments,
      severityGate: r.severity_gate ?? r.severityGate ?? base.review.severityGate,
      verify: r.verify ?? base.review.verify,
      incremental: r.incremental ?? base.review.incremental,
      minConfidence: r.min_confidence ?? r.minConfidence ?? base.review.minConfidence,
      language: r.language ?? base.review.language,
      skillsDir: r.skills_dir ?? r.skillsDir ?? base.review.skillsDir,
      enabledSkills: fileCfg?.skills?.enabled ?? base.review.enabledSkills,
      redactPatterns: r.redact_patterns ?? r.redactPatterns ?? base.review.redactPatterns,
      autoSummaryLines: r.auto_summary_lines ?? r.autoSummaryLines ?? base.review.autoSummaryLines,
      vote: r.vote ?? base.review.vote,
      dailyTokenBudget: r.daily_token_budget ?? r.dailyTokenBudget ?? base.review.dailyTokenBudget,
    },
    notify: { on: fileCfg?.notify?.on ?? base.notify.on },
    assistant: { trigger: fileCfg?.assistant?.trigger ?? base.assistant.trigger },
  };
}

/**
 * 服务端基础配置：默认值 + 本地 .ai-review.yml（可选）+ 环境变量（密钥只从这里来）。
 * 多项目部署时它只是兜底，各仓库的 .ai-review.yml 会在审查时叠加（见 resolveProjectConfig）。
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

  // CI_SERVER_URL 是 GitLab CI 预置变量——CI 模式下不用手动配地址
  const gitlabUrl = process.env.GITLAB_URL ?? process.env.CI_SERVER_URL ?? fileCfg.gitlab?.url ?? "https://gitlab.com";
  const base: Config = {
    gitlabUrl: gitlabUrl.replace(/\/+$/, ""),
    gitlabToken: process.env.GITLAB_TOKEN ?? "",
    webhookSecret: process.env.WEBHOOK_SECRET,
    ai: { ...DEFAULTS.ai },
    review: { ...DEFAULTS.review },
    notify: { ...DEFAULTS.notify },
    assistant: { ...DEFAULTS.assistant },
  };
  return mergeFileConfig(base, fileCfg);
}

/**
 * 项目级配置：从目标仓库的 ref（通常是 MR 的 target 分支，防止 MR 作者在自己分支里
 * 篡改审查配置）拉取 .ai-review.yml，叠加在服务端配置之上。
 * 仓库配置不允许覆盖 ai.base_url（防止把带 API key 的请求引到别处）。
 */
export async function resolveProjectConfig(
  base: Config,
  gl: GitLab,
  project: string | number,
  ref: string,
): Promise<{ cfg: Config; source: string }> {
  for (const path of [".ai-review.yml", ".ai-review.yaml"]) {
    try {
      const raw = await gl.getRawFile(project, path, ref);
      const fileCfg = YAML.parse(raw) ?? {};
      if (fileCfg?.ai) {
        delete fileCfg.ai.base_url;
        delete fileCfg.ai.baseUrl;
      }
      return { cfg: mergeFileConfig(base, fileCfg), source: `${path} @ ${ref}` };
    } catch {
      /* 没有该文件，尝试下一个候选 */
    }
  }
  return { cfg: base, source: "服务端默认配置" };
}

/** 把「文件形态」的配置对象（snake_case，即页面提交的 JSON）序列化为 .ai-review.yml 内容。 */
export function fileConfigToYaml(fileCfg: any): string {
  const clean = (o: any): any => {
    if (o === null || o === undefined) return undefined;
    if (typeof o !== "object" || Array.isArray(o)) return o;
    const out: any = {};
    for (const [k, v] of Object.entries(o)) {
      const c = clean(v);
      if (c !== undefined && c !== "") out[k] = c;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  return "# 由 mergelens 配置页生成\n" + YAML.stringify(clean(fileCfg) ?? {});
}

/** 服务端配置文件的落盘路径（与 loadConfig 的读取路径对称）。 */
export function serverConfigPath(): string {
  return process.env.MERGELENS_CONFIG ?? resolve(process.cwd(), ".ai-review.yml");
}

export function requireToken(cfg: Config): void {
  if (!cfg.gitlabToken) {
    throw new Error("缺少 GITLAB_TOKEN 环境变量（GitLab personal/group access token，需 api 权限）");
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

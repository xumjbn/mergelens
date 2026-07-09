import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "./types.js";
import type { GitLab } from "./gitlab.js";
import { matchGlob } from "./diff.js";

/** 各仓库自定义 skill 的约定目录 */
export const REPO_SKILLS_DIR = ".mergelens/skills";

/**
 * A skill is a markdown file with optional YAML-ish frontmatter:
 *   ---
 *   name: security
 *   trigger: "**\/*"          (comma-separated globs allowed)
 *   severity_weight: 1.4
 *   model: claude-sonnet-5    (optional per-skill override)
 *   ---
 *   ...natural-language review rules...
 */
export function parseSkill(fileName: string, raw: string): Skill {
  let body = raw;
  const meta: Record<string, string> = {};
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    for (const line of fm[1].split(/\r?\n/)) {
      const m = /^([\w-]+):\s*(.*)$/.exec(line.trim());
      if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return {
    name: meta.name ?? fileName.replace(/\.md$/, ""),
    triggers: meta.trigger ? meta.trigger.split(",").map((s) => s.trim()).filter(Boolean) : [],
    severityWeight: meta.severity_weight ? parseFloat(meta.severity_weight) : 1.0,
    model: meta.model || undefined,
    body: body.trim(),
  };
}

/** 解析内置 skill 实际所在目录（配置目录不存在时回落到随包发布的 skills/）。 */
export function skillsRoot(dir: string): string | null {
  if (existsSync(dir)) return dir;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", "skills"), join(here, "..", "..", "skills")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Load skills from dir; falls back to the skills/ folder shipped with mergelens. */
export function loadSkills(dir: string, enabled: string[] | "all"): Skill[] {
  const root = skillsRoot(dir);
  if (!root) return [];
  const skills = readdirSync(root)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseSkill(f, readFileSync(join(root, f), "utf8")));
  if (enabled === "all") return skills;
  return skills.filter((s) => enabled.includes(s.name));
}

/** 内置 skill 的文件原文（在线编辑页用，raw 含 frontmatter）。 */
export function listBuiltinFiles(dir: string): Array<{ file: string; raw: string; skill: Skill }> {
  const root = skillsRoot(dir);
  if (!root) return [];
  return readdirSync(root)
    .filter((f) => f.endsWith(".md"))
    .map((f) => {
      const raw = readFileSync(join(root, f), "utf8");
      return { file: f, raw, skill: parseSkill(f, raw) };
    });
}

/** Does this skill apply to at least one changed file? */
export function skillApplies(skill: Skill, changedPaths: string[]): boolean {
  if (skill.triggers.length === 0) return true;
  return changedPaths.some((p) => skill.triggers.some((g) => matchGlob(g, p)));
}

/** 从目标仓库的 .mergelens/skills/ 拉取自定义 skill（目录不存在返回空）。 */
export async function loadRepoSkills(
  gl: GitLab,
  project: string | number,
  ref: string,
): Promise<Skill[]> {
  const entries = await gl.listTree(project, REPO_SKILLS_DIR, ref);
  const mds = entries.filter((e) => e.type === "blob" && e.name.endsWith(".md"));
  const skills: Skill[] = [];
  for (const e of mds) {
    try {
      skills.push(parseSkill(e.name, await gl.getRawFile(project, e.path, ref)));
    } catch (err) {
      console.error(`[skills] 加载 ${e.path} 失败：${(err as Error).message}`);
    }
  }
  return skills;
}

/** 合并内置与仓库 skill：同名时仓库覆盖内置；再按 enabled 白名单过滤。 */
export function mergeSkills(
  builtin: Skill[],
  repo: Skill[],
  enabled: string[] | "all",
): Skill[] {
  const byName = new Map<string, Skill>();
  for (const s of builtin) byName.set(s.name, s);
  for (const s of repo) byName.set(s.name, s);
  const all = [...byName.values()];
  return enabled === "all" ? all : all.filter((s) => enabled.includes(s.name));
}

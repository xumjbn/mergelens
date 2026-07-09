import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Skill } from "./types.js";
import { matchGlob } from "./diff.js";

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

/** Load skills from dir; falls back to the skills/ folder shipped with mergelens. */
export function loadSkills(dir: string, enabled: string[] | "all"): Skill[] {
  let root = dir;
  if (!existsSync(root)) {
    const here = dirname(fileURLToPath(import.meta.url));
    const bundled = join(here, "..", "skills");
    if (existsSync(bundled)) root = bundled;
    else return [];
  }
  const skills = readdirSync(root)
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseSkill(f, readFileSync(join(root, f), "utf8")));
  if (enabled === "all") return skills;
  return skills.filter((s) => enabled.includes(s.name));
}

/** Does this skill apply to at least one changed file? */
export function skillApplies(skill: Skill, changedPaths: string[]): boolean {
  if (skill.triggers.length === 0) return true;
  return changedPaths.some((p) => skill.triggers.some((g) => matchGlob(g, p)));
}

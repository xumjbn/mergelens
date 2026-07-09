import type { DiffLine, MrChange, ParsedFile } from "./types.js";

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Parse one unified diff body into typed lines with old/new line numbers. */
export function parseDiff(path: string, diff: string): ParsedFile {
  const lines: DiffLine[] = [];
  let oldN = 0;
  let newN = 0;
  let added = 0;
  let deleted = 0;

  for (const raw of diff.split("\n")) {
    const hunk = HUNK_RE.exec(raw);
    if (hunk) {
      oldN = parseInt(hunk[1], 10);
      newN = parseInt(hunk[2], 10);
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ type: "add", oldLine: null, newLine: newN, text: raw.slice(1) });
      newN++;
      added++;
    } else if (raw.startsWith("-")) {
      lines.push({ type: "del", oldLine: oldN, newLine: null, text: raw.slice(1) });
      oldN++;
      deleted++;
    } else if (raw.startsWith(" ") || raw === "") {
      lines.push({ type: "ctx", oldLine: oldN, newLine: newN, text: raw.slice(1) });
      oldN++;
      newN++;
    }
    // ignore "\ No newline at end of file" etc.
  }
  return { path, lines, addedCount: added, deletedCount: deleted };
}

/** Trivial glob matcher supporting `*`, `**` and `{a,b}` — enough for ignore/trigger patterns. */
export function matchGlob(pattern: string, path: string): boolean {
  const expandBraces = (p: string): string[] => {
    const m = /\{([^}]+)\}/.exec(p);
    if (!m) return [p];
    return m[1].split(",").flatMap((alt) => expandBraces(p.replace(m[0], alt)));
  };
  return expandBraces(pattern).some((p) => {
    // single-pass tokenizer — chained replaces would mangle each other's output
    let re = "";
    for (let i = 0; i < p.length; i++) {
      if (p.startsWith("**/", i)) { re += "(?:.*/)?"; i += 2; }
      else if (p.startsWith("**", i)) { re += ".*"; i += 1; }
      else if (p[i] === "*") re += "[^/]*";
      else if (p[i] === "?") re += "[^/]";
      else re += p[i].replace(/[.+^$()|[\]\\{}]/, "\\$&");
    }
    // a bare "*.ts" style pattern should match at any depth
    const anchored = p.includes("/") ? `^${re}$` : `(^|/)${re}$`;
    return new RegExp(anchored).test(path);
  });
}

export function isIgnored(path: string, ignorePatterns: string[]): boolean {
  return ignorePatterns.some((p) => matchGlob(p, path));
}

/**
 * Render a file diff annotated with NEW-file line numbers, the format the
 * review prompt uses so the model can cite exact lines:
 *   `  23 + const x = 1;`   added
 *   `  24   ctx line`       context
 *   `     - removed line`   deleted (no new-line number)
 */
export function annotate(file: ParsedFile): string {
  const out: string[] = [`### ${file.path}`];
  for (const l of file.lines) {
    const n = l.newLine !== null ? String(l.newLine).padStart(5) : "     ";
    const mark = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
    out.push(`${n} ${mark} ${l.text}`);
  }
  return out.join("\n");
}

/** Which new-file lines were ADDED (only these can carry inline comments reliably). */
export function addedLineSet(file: ParsedFile): Set<number> {
  const s = new Set<number>();
  for (const l of file.lines) if (l.type === "add" && l.newLine !== null) s.add(l.newLine);
  return s;
}

/** Prepare MR changes: filter ignored/binary, parse, enforce the total line budget. */
export function prepareChanges(
  changes: MrChange[],
  ignorePatterns: string[],
  maxLines: number,
): { files: ParsedFile[]; skipped: string[]; truncated: boolean } {
  const files: ParsedFile[] = [];
  const skipped: string[] = [];
  let budget = maxLines;
  let truncated = false;

  // biggest churn first — if we truncate, we keep the most substantial files
  const sorted = [...changes].sort((a, b) => b.diff.length - a.diff.length);

  for (const c of sorted) {
    if (c.deleted_file || !c.diff) continue;
    if (isIgnored(c.new_path, ignorePatterns)) {
      skipped.push(c.new_path);
      continue;
    }
    const parsed = parseDiff(c.new_path, c.diff);
    const cost = parsed.lines.length;
    if (cost > budget) {
      truncated = true;
      skipped.push(c.new_path);
      continue;
    }
    budget -= cost;
    files.push(parsed);
  }
  return { files, skipped, truncated };
}

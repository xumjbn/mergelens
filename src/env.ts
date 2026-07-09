import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 加载 .env 文件（当前目录，或 MERGELENS_ENV 指定路径）。
 * 已存在的环境变量优先——.env 只补空缺，不覆盖。
 * 解决「set 的变量只在当前终端有效，换个窗口起服务就丢配置」的问题。
 */
export function loadDotEnv(): string | null {
  const path = process.env.MERGELENS_ENV ?? resolve(process.cwd(), ".env");
  if (!existsSync(path)) return null;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return path;
}

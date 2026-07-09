import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 常驻后台：start 派生独立的 serve 进程（脱离终端），stop/status/logs 管理它。
 * 进程信息存 data/daemon.json，日志写 data/mergelens.log。
 * 生产环境建议再套一层 systemd（Linux）/ 计划任务或 NSSM（Windows）做开机自启与崩溃拉起。
 */

interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: string;
}

function dataDir(): string {
  return process.env.MERGELENS_DATA ?? join(process.cwd(), "data");
}
const infoFile = (): string => join(dataDir(), "daemon.json");
export const logFile = (): string => join(dataDir(), "mergelens.log");

function readInfo(): DaemonInfo | null {
  try {
    return JSON.parse(readFileSync(infoFile(), "utf8")) as DaemonInfo;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function daemonStart(port: number): void {
  const prev = readInfo();
  if (prev && alive(prev.pid)) {
    throw new Error(`服务已在运行（pid ${prev.pid}，端口 ${prev.port}）。先 mergelens stop 或直接 mergelens status`);
  }
  mkdirSync(dataDir(), { recursive: true });
  // 日志轮转：超 5MB 时归档为 .1（保留一代），避免只增不减
  try {
    const lf = logFile();
    if (existsSync(lf) && statSync(lf).size > 5 * 1024 * 1024) {
      rmSync(lf + ".1", { force: true });
      renameSync(lf, lf + ".1");
    }
  } catch { /* 轮转失败不阻塞启动 */ }
  const out = openSync(logFile(), "a");
  const here = dirname(fileURLToPath(import.meta.url));
  const distServer = join(here, "server.js");           // 已编译（node dist/cli.js start）
  const srcServer = join(here, "..", "dist", "server.js"); // tsx 开发态时找编译产物

  const env = { ...process.env, PORT: String(port) };
  let child;
  if (existsSync(distServer) && distServer.endsWith(".js")) {
    child = spawn(process.execPath, [distServer], {
      detached: true, stdio: ["ignore", out, out], env, windowsHide: true,
    });
  } else if (existsSync(srcServer)) {
    child = spawn(process.execPath, [srcServer], {
      detached: true, stdio: ["ignore", out, out], env, windowsHide: true,
    });
  } else {
    // 开发态兜底：未 build 时用 tsx 起（shell 方式，Windows 兼容 npx.cmd）
    const serverTs = join(here, "server.ts");
    child = spawn(`npx tsx "${serverTs}"`, {
      shell: true, detached: true, stdio: ["ignore", out, out], env, windowsHide: true,
    });
  }
  if (!child.pid) throw new Error("派生后台进程失败");
  writeFileSync(infoFile(), JSON.stringify({ pid: child.pid, port, startedAt: new Date().toISOString() } satisfies DaemonInfo));
  child.unref();
  console.log(`已在后台启动（pid ${child.pid}，端口 ${port}）`);
  console.log(`  日志：${logFile()}`);
  console.log(`  状态：mergelens status  ·  停止：mergelens stop`);
  console.log(`  提示：建议 npm run build 后再 start（直接跑编译产物，比 tsx 兜底更稳）`);
}

export function daemonStop(): void {
  const info = readInfo();
  if (!info || !alive(info.pid)) {
    rmSync(infoFile(), { force: true });
    console.log("服务未在运行");
    return;
  }
  if (process.platform === "win32") {
    // shell 派生的场景下要连子进程一起杀
    execSync(`taskkill /pid ${info.pid} /T /F`, { stdio: "ignore" });
  } else {
    process.kill(info.pid, "SIGTERM");
  }
  rmSync(infoFile(), { force: true });
  console.log(`已停止（pid ${info.pid}）`);
}

export async function daemonStatus(): Promise<boolean> {
  const info = readInfo();
  if (!info || !alive(info.pid)) {
    console.log("状态：未运行");
    return false;
  }
  console.log(`状态：运行中（pid ${info.pid}，端口 ${info.port}，启动于 ${info.startedAt}）`);
  // 用 node:http 直连 localhost，绕开代理 dispatcher
  const health = await new Promise<string | null>((res) => {
    const req = get({ host: "127.0.0.1", port: info.port, path: "/health", timeout: 3000 }, (r) => {
      let b = "";
      r.on("data", (c) => (b += c));
      r.on("end", () => res(b));
    });
    req.on("error", () => res(null));
    req.on("timeout", () => { req.destroy(); res(null); });
  });
  if (health) {
    const h = JSON.parse(health);
    console.log(`健康检查：ok，队列 ${h.queued}，进行中 ${h.running?.length ?? 0}，近期事件 ${h.recentEvents?.length ?? 0} 条`);
  } else {
    console.log(`健康检查：进程存活但 /health 无响应（可能刚启动或端口被占，看日志 ${logFile()}）`);
  }
  return true;
}

export function daemonLogs(lines: number): void {
  if (!existsSync(logFile())) {
    console.log(`还没有日志（${logFile()}）`);
    return;
  }
  const all = readFileSync(logFile(), "utf8").split("\n");
  console.log(all.slice(-lines).join("\n"));
}

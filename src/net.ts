import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

let applied = false;

/**
 * Node 的全局 fetch 默认忽略 HTTP_PROXY/HTTPS_PROXY 环境变量。
 * 检测到代理环境变量时挂载 EnvHttpProxyAgent（同时尊重 NO_PROXY）。
 *
 * 内网 GitLab + 外网 AI API 的典型配置：
 *   HTTPS_PROXY=http://proxy:port   （AI API 走代理）
 *   NO_PROXY=gitlab.internal.com    （内网 GitLab 直连）
 */
export function setupProxyFromEnv(): string | null {
  if (applied) return null;
  applied = true;
  const proxy =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ??
    process.env.HTTP_PROXY ?? process.env.http_proxy;
  if (!proxy) return null;
  setGlobalDispatcher(new EnvHttpProxyAgent());
  return proxy;
}

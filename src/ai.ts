import type { AiConfig } from "./types.js";

export interface ChatOptions {
  /** override model (e.g. light model for summaries) */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

import { AsyncLocalStorage } from "node:async_hooks";

/**
 * token 计量：按异步上下文隔离（服务端 3 个 MR 并行审查时互不串账）。
 * pipeline 用 inTokenScope 包住一次审查，scope 内所有 chat 调用自动累计。
 */
const meterAls = new AsyncLocalStorage<{ input: number; output: number }>();

export function inTokenScope<T>(fn: () => Promise<T>): Promise<T> {
  return meterAls.run({ input: 0, output: 0 }, fn);
}

export function currentTokens(): { input: number; output: number } {
  const m = meterAls.getStore();
  return m ? { input: m.input, output: m.output } : { input: 0, output: 0 };
}

function countTokens(i?: number, o?: number): void {
  const m = meterAls.getStore();
  if (m) {
    m.input += i || 0;
    m.output += o || 0;
  }
}

const OPENAI_COMPAT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  ollama: "http://localhost:11434/v1",
};

/**
 * Unified chat call across providers. Returns assistant text.
 * 失败时逐级回退：指定模型（如轻量模型）→ 主模型 → 降级模型——
 * 轻量模型配错名字不再让摘要/验证整条链路挂掉。
 */
export async function chat(
  ai: AiConfig,
  system: string,
  user: string,
  opts: ChatOptions = {},
): Promise<string> {
  const candidates = [opts.model ?? ai.model, ai.model, ai.fallbackModel]
    .filter((m): m is string => !!m)
    .filter((m, i, a) => a.indexOf(m) === i);
  let lastErr: Error = new Error("no model configured");
  for (let i = 0; i < candidates.length; i++) {
    try {
      return await callOnce(ai, candidates[i], system, user, opts);
    } catch (err) {
      lastErr = err as Error;
      if (i < candidates.length - 1) {
        console.error(`[ai] ${candidates[i]} 调用失败（${lastErr.message.slice(0, 140)}），改用 ${candidates[i + 1]}`);
      }
    }
  }
  throw lastErr;
}

async function callOnce(
  ai: AiConfig,
  model: string,
  system: string,
  user: string,
  opts: ChatOptions,
): Promise<string> {
  if (ai.provider === "anthropic") {
    const res = await fetch((ai.baseUrl ?? "https://api.anthropic.com") + "/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? ai.maxTokens,
        temperature: opts.temperature ?? ai.temperature,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
    countTokens(data.usage?.input_tokens, data.usage?.output_tokens);
    return (data.content ?? [])
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
  }

  // OpenAI-compatible providers
  const base = ai.baseUrl ?? OPENAI_COMPAT_BASE[ai.provider];
  const key =
    ai.provider === "openai" ? process.env.OPENAI_API_KEY
    : ai.provider === "deepseek" ? process.env.DEEPSEEK_API_KEY
    : "ollama";
  const res = await fetch(base + "/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key ?? ""}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens ?? ai.maxTokens,
      temperature: opts.temperature ?? ai.temperature,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`${ai.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
  countTokens(data.usage?.prompt_tokens, data.usage?.completion_tokens);
  return data.choices?.[0]?.message?.content ?? "";
}

/** Extract the first JSON object/array from model output (tolerates ``` fences and prose). */
export function extractJson<T>(text: string): T {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start === -1) throw new Error("模型输出中未找到 JSON: " + text.slice(0, 200));
  // walk to the matching close bracket
  const open = body[start];
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(body.slice(start, i + 1)) as T;
    }
  }
  // 抢救式解析：输出被 max_tokens 截断的数组，砍到最后一个完整对象再闭合，保住已产出的部分
  if (open === "[") {
    const lastObj = body.lastIndexOf("}");
    if (lastObj > start) {
      try {
        const repaired = body.slice(start, lastObj + 1).replace(/,\s*$/, "") + "]";
        const arr = JSON.parse(repaired) as T;
        console.error("[ai] 模型输出被截断，已抢救解析出前面完整的部分");
        return arr;
      } catch { /* 抢救失败走正常报错 */ }
    }
  }
  throw new Error("JSON 未闭合: " + body.slice(start, start + 200));
}

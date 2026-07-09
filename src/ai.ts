import type { AiConfig } from "./types.js";

export interface ChatOptions {
  /** override model (e.g. light model for summaries) */
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

const OPENAI_COMPAT_BASE: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  ollama: "http://localhost:11434/v1",
};

/** Unified chat call across providers. Returns assistant text. */
export async function chat(
  ai: AiConfig,
  system: string,
  user: string,
  opts: ChatOptions = {},
): Promise<string> {
  const model = opts.model ?? ai.model;
  try {
    return await callOnce(ai, model, system, user, opts);
  } catch (err) {
    if (ai.fallbackModel && ai.fallbackModel !== model) {
      console.error(`[ai] ${model} 调用失败（${(err as Error).message}），降级到 ${ai.fallbackModel}`);
      return callOnce(ai, ai.fallbackModel, system, user, opts);
    }
    throw err;
  }
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
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data: any = await res.json();
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
  });
  if (!res.ok) throw new Error(`${ai.provider} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data: any = await res.json();
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
  throw new Error("JSON 未闭合: " + body.slice(start, start + 200));
}

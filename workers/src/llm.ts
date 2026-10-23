// NVIDIA NIM chat client for Workers: one call with model fallback + one retry.
// No rate limiter: a workflow step performs a single call, so NIM's 38 RPM is
// not reachable in normal sequential operation.
// deno-lint-ignore-file no-explicit-any
export type Msg = any;

export const DEFAULT_MODELS = {
  leader: "nvidia/nemotron-3-ultra-550b-a55b",
  fallback: "nvidia/nemotron-3-super-120b-a12b",
  vision: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  visionFallback: "meta/llama-3.2-11b-vision-instruct",
};

export interface LlmEnv {
  NVIDIA_API_KEY: string;
  MODEL_LEADER?: string;
  MODEL_FALLBACK?: string;
  MODEL_VISION?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function once(base: string, key: string, model: string, messages: Msg[], tools: unknown, temperature: number): Promise<Msg> {
  const body: Record<string, unknown> = { model, messages, temperature, max_tokens: 4096 };
  if (tools) { body.tools = tools; body.tool_choice = "auto"; }
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`NIM ${res.status}: ${t.slice(0, 200)}`); }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error("NIM returned no message");
  return msg;
}

async function runChain(env: LlmEnv, chain: string[], messages: Msg[], tools: unknown, temperature: number): Promise<Msg> {
  const base = "https://integrate.api.nvidia.com";
  let last: unknown = null;
  for (const model of chain) {
    for (let attempt = 0; attempt < 1; attempt++) {
      try { return await once(base, env.NVIDIA_API_KEY, model, messages, tools, temperature); }
      catch (e) {
        last = e;
        const m = String(e instanceof Error ? e.message : e);
        if (/NIM (404|403)/.test(m)) break; // key refused for this model: try the next model
        if (attempt === 0) await sleep(1500);
      }
    }
  }
  throw last ?? new Error("no usable model");
}

export function llmChat(env: LlmEnv, messages: Msg[], tools?: unknown, temperature = 0.2): Promise<Msg> {
  const leader = env.MODEL_LEADER?.trim() || DEFAULT_MODELS.leader;
  const fallback = env.MODEL_FALLBACK?.trim() || DEFAULT_MODELS.fallback;
  return runChain(env, [leader, fallback], messages, tools, temperature);
}

export async function llmVision(env: LlmEnv, b64Jpeg: string, prompt: string): Promise<string> {
  const vision = env.MODEL_VISION?.trim() || DEFAULT_MODELS.vision;
  const msgs = [{ role: "user", content: [
    { type: "text", text: prompt },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64Jpeg}` } },
  ] }];
  const m = await runChain(env, [vision, DEFAULT_MODELS.visionFallback], msgs, undefined, 0.1);
  return String(m?.content ?? "");
}

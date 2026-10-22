// NVIDIA NIM chat client: shared rate limiter, retry + fallback model, vision helper.
// deno-lint-ignore-file no-explicit-any
export type Msg = any;

export const DEFAULT_MODELS = {
  leader: "nvidia/nemotron-3-ultra-550b-a55b",
  fallback: "nvidia/nemotron-3-super-120b-a12b",
  vision: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  visionFallback: "meta/llama-3.2-11b-vision-instruct",
};

export class RateLimiter {
  private calls: number[] = [];
  private maxCalls: number;
  private periodMs: number;
  constructor(maxCalls = 38, periodMs = 60_000) { this.maxCalls = maxCalls; this.periodMs = periodMs; }
  async acquire(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.calls.length && now - this.calls[0] >= this.periodMs) this.calls.shift();
      if (this.calls.length < this.maxCalls) { this.calls.push(now); return; }
      await new Promise((r) => setTimeout(r, Math.max(50, this.periodMs - (now - this.calls[0]) + 5)));
    }
  }
}

export interface LlmOpts {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  rpm?: number;
  models?: Partial<typeof DEFAULT_MODELS>;
  retryDelayMs?: number;
  timeoutMs?: number;
}

export function createLlm(o: LlmOpts) {
  const doFetch = o.fetchFn ?? fetch;
  const url = (o.baseUrl ?? "https://integrate.api.nvidia.com") + "/v1/chat/completions";
  const models = { ...DEFAULT_MODELS, ...(o.models ?? {}) };
  const limiter = new RateLimiter(o.rpm ?? 38);
  const dead = new Set<string>(); // models the key is refused for (404/403): skipped for the rest of the process

  async function once(model: string, messages: Msg[], tools: unknown, temperature: number): Promise<Msg> {
    await limiter.acquire();
    const body: Record<string, unknown> = { model, messages, temperature, max_tokens: 4096 };
    if (tools) { body.tools = tools; body.tool_choice = "auto"; }
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs ?? 120_000),
    });
    if (!res.ok) { const t = await res.text(); throw new Error(`NIM ${res.status}: ${t.slice(0, 200)}`); }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (!msg) throw new Error("NIM returned no message");
    return msg;
  }

  async function run(chain: string[], messages: Msg[], tools: unknown, temperature: number): Promise<Msg> {
    let last: unknown = null;
    for (const model of chain) {
      if (dead.has(model)) continue;
      for (let attempt = 0; attempt < 2; attempt++) {
        try { return await once(model, messages, tools, temperature); }
        catch (e) {
          last = e; const m = String(e instanceof Error ? e.message : e);
          if (/NIM (404|403)/.test(m)) { dead.add(model); break; }
          if (attempt === 0) await new Promise((r) => setTimeout(r, o.retryDelayMs ?? 1200));
        }
      }
    }
    throw last ?? new Error("no usable model");
  }

  return {
    models, limiter,
    chat: (messages: Msg[], tools?: unknown, temperature = 0.2) => run([models.leader, models.fallback], messages, tools, temperature),
    async vision(b64Png: string, prompt: string): Promise<string> {
      const msgs = [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: `data:image/png;base64,${b64Png}` } }] }];
      const m = await run([models.vision, models.visionFallback], msgs, undefined, 0.1);
      return String(m.content ?? "");
    },
  };
}

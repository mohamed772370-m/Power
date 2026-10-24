// NVIDIA NIM chat client for Workers: model fallback chain with per-model error
// aggregation, bounded 429 backoff, and a short-TTL dead-model cache.
// 2026-10-24 correction: the "38 RPM unreachable" assumption died - the account is
// shared, leader 429s happen under combined load, and the fallback function can be
// account-unavailable (404) for long windows.
// deno-lint-ignore-file no-explicit-any
export type Msg = any;

export const DEFAULT_MODELS = {
  leader: "nvidia/nemotron-3-ultra-550b-a55b",
  fallback: "nvidia/nemotron-3-super-120b-a12b",
  vision: "nvidia/nemotron-3.5-super-vl-120b-a12b",
  visionFallback: "meta/llama-3.2-11b-vision-instruct",
  // Cross-provider terminal fallback (2026-10-24, user decision 05:40): Google
  // Gemini, keyed by the user's "Gemini API key (Google AI Studio)" vault entry.
  // Pinned by probe evidence: 2.5-pro is 404-retired for new keys, 3.1-pro-preview
  // has ZERO free-tier quota (HTTP 429 limit:0), 3.5-flash answered 200 with a
  // well-formed functionCall in 1.4s; 3.8-flash also worked but took 28s.
  googleFallback: "gemini-3.5-flash",
};

export interface LlmEnv {
  NVIDIA_API_KEY: string;
  MODEL_LEADER?: string;
  MODEL_FALLBACK?: string;
  MODEL_VISION?: string;
  GOOGLE_API_KEY?: string;   // staging secret only, never logged
  GOOGLE_MODEL_FALLBACK?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function once(base: string, key: string, model: string, messages: Msg[], tools: unknown, temperature: number): Promise<Msg> {
  // Strip Gemini thought signatures from the OUTBOUND NIM body only (reviewer
  // finding 2): stored state keeps them for later Gemini calls; NIM pairing is
  // by tool_call_id and the extra field is unverified-ignored, so do not send it.
  const nimMessages = messages.map((m) => {
    if (!Array.isArray(m?.tool_calls)) return m;
    return { ...m, tool_calls: m.tool_calls.map((tc: Msg) => {
      if (!tc || typeof tc !== "object" || !("thought_signature" in tc)) return tc;
      const { thought_signature: _drop, ...rest } = tc as Record<string, unknown>;
      return rest;
    }) };
  });
  const body: Record<string, unknown> = { model, messages: nimMessages, temperature, max_tokens: 4096 };
  if (tools) { body.tools = tools; body.tool_choice = "auto"; }
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`NIM ${res.status}: ${t.slice(0, 200)}`) as Error & { retryAfter?: number };
    const ra = res.headers.get("retry-after");
    if (ra && /^\d+$/.test(ra.trim())) err.retryAfter = Math.min(parseInt(ra.trim(), 10), 120);
    throw err;
  }
  const data = await res.json();
  const msg = data?.choices?.[0]?.message;
  if (!msg) throw new Error("NIM returned no message");
  return msg;
}

// Short-TTL dead-model cache: models that returned 404/403 (function unavailable
// for this account) are skipped for 5 minutes so an outage is not rediscovered at
// full chain cost on every job. Per-isolate in-memory: a cold isolate rediscovers
// once - accepted, zero KV cost.
const DEAD_MODEL_TTL_MS = 5 * 60_000;
const deadModels = new Map<string, number>(); // model -> expiry epoch ms

async function runChain(env: LlmEnv, chain: string[], messages: Msg[], tools: unknown, temperature: number): Promise<Msg> {
  const base = "https://integrate.api.nvidia.com";
  const errs: string[] = [];
  for (const model of chain) {
    const deadUntil = deadModels.get(model) ?? 0;
    if (deadUntil > Date.now()) {
      errs.push(`${model}: skipped (dead-model cache, ${Math.ceil((deadUntil - Date.now()) / 1000)}s left)`);
      continue;
    }
    deadModels.delete(model);
    // Up to 2 attempts when the failure is a 429 (bounded backoff: Retry-After
    // header, else 30s, capped 45s - inside the job wall-clock budget); a single
    // attempt for every other failure.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await once(base, env.NVIDIA_API_KEY, model, messages, tools, temperature); }
      catch (e) {
        const m = String(e instanceof Error ? e.message : e);
        errs.push(`${model}: ${m.slice(0, 120)}`);
        // Per-model failure visibility (deployed 771ea44): the chain used to surface
        // only the LAST model's error, masking the leader's real failure.
        console.warn(`llm model failed: ${model}: ${m.slice(0, 300)}`);
        if (/NIM (404|403)/.test(m)) { deadModels.set(model, Date.now() + DEAD_MODEL_TTL_MS); break; } // function unavailable for this account: cache dead, try next model
        if (/NIM 429/.test(m) && attempt === 0) {
          const waitMs = Math.min((((e as { retryAfter?: number })?.retryAfter) ?? 30), 45) * 1000;
          await sleep(waitMs);
          continue;
        }
        break; // non-retriable for this model: try the next model
      }
    }
  }
  // Aggregate: the terminal error names EVERY model's own failure, not just the last.
  throw new Error(errs.join(" | ") || "no usable model");
}


// ---- Google Gemini terminal fallback (review-only proposal) ----
// OpenAI-shaped messages/tools <-> Gemini generateContent. Runs ONLY after the
// whole NIM chain failed, and ONLY when GOOGLE_API_KEY is set (staging secret).
const GEMINI_BASE = "https://generativelanguage.googleapis.com";

// Exported for unit tests (converter has live-API failure modes that must be pinned).
export function toGeminiContents(messages: Msg[]): { system?: string; contents: unknown[] } {
  let system: string | undefined;
  const contents: unknown[] = [];
  // Gemini pairs functionResponse<->functionCall BY NAME (no id concept). Our
  // history renames some tool results (act->browser_step, agent.ts:482), so the
  // result's m.name is unreliable: resolve the ORIGINAL call name via tool_call_id
  // against preceding assistant tool_calls (reviewer finding 1, confirmed real).
  const nameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const tc of m.tool_calls ?? []) {
        if (tc?.id && tc?.function?.name) nameById.set(String(tc.id), String(tc.function.name));
      }
    }
  }
  for (const m of messages) {
    if (m.role === "system") { system = (system ? system + "\n" : "") + String(m.content ?? ""); continue; }
    if (m.role === "user") { contents.push({ role: "user", parts: [{ text: typeof m.content === "string" ? m.content : JSON.stringify(m.content) }] }); continue; }
    if (m.role === "assistant") {
      const parts: unknown[] = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const tc of m.tool_calls ?? []) {
        let args: unknown = {};
        try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { args = {}; }
        // Gemini 3 requires a part-level thought_signature on replayed functionCall
        // parts (HTTP 400 otherwise - verified). Signatures returned by Gemini are
        // stored on the tool_call (camelCase on the wire) and replayed verbatim;
        // history written by NIM has none, so use the documented bypass token.
        // Field placement verified empirically: sibling of functionCall, snake_case
        // in requests; v1beta rejects functionCall.thoughtSignature (HTTP 400).
        parts.push({ functionCall: { name: tc.function?.name, args },
          thought_signature: tc.thought_signature ?? "skip_thought_signature_validator" });
      }
      contents.push({ role: "model", parts: parts.length ? parts : [{ text: "" }] });
      continue;
    }
    if (m.role === "tool") {
      // Gemini expects tool results as functionResponse parts in a user turn.
      const fnName = (m.tool_call_id && nameById.get(String(m.tool_call_id))) || m.name || "tool";
      contents.push({ role: "user", parts: [{ functionResponse: { name: fnName, response: { result: String(m.content ?? "") } } }] });
      continue;
    }
  }
  return { system, contents };
}

async function geminiOnce(key: string, model: string, messages: Msg[], tools: unknown, temperature: number): Promise<Msg> {
  const { system, contents } = toGeminiContents(messages);
  const body: Record<string, unknown> = { contents, generationConfig: { temperature, maxOutputTokens: 4096 } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (Array.isArray(tools) && tools.length) {
    const decls = (tools as { function?: { name?: string; description?: string; parameters?: unknown } }[])
      .map((t) => t.function).filter(Boolean)
      .map((f) => ({ name: f!.name, description: f!.description, parameters: f!.parameters }));
    body.tools = [{ functionDeclarations: decls }];
    body.toolConfig = { functionCallingConfig: { mode: "AUTO" } };
  }
  const res = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const t = await res.text();
    // NOTE: a 429 here is usually a DAILY free-tier quota (limit:0) - pointless to
    // retry inside the job window, so the caller retries ONLY transient 5xx.
    const err = new Error(`Gemini ${res.status}: ${t.slice(0, 200)}`) as Error & { retryAfter?: number };
    const ra = res.headers.get("retry-after");
    if (ra && /^\d+$/.test(ra.trim())) err.retryAfter = parseInt(ra.trim(), 10);
    throw err;
  }
  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || !parts.length) throw new Error("Gemini returned no content parts");
  const out: Msg = { role: "assistant", content: "" };
  const texts: string[] = [];
  const tcs: unknown[] = [];
  parts.forEach((p: { text?: string; functionCall?: { name?: string; args?: unknown } }, i: number) => {
    if (p.text) texts.push(p.text);
    if (p.functionCall?.name) {
      const tc: Msg = { id: `call_gem_${Date.now()}_${i}`, type: "function",
        function: { name: p.functionCall.name, arguments: JSON.stringify(p.functionCall.args ?? {}) } };
      // Preserve the returned thought signature (camelCase on responses) for replay.
      const sig = (p as { thoughtSignature?: string }).thoughtSignature;
      if (sig) tc.thought_signature = sig;
      tcs.push(tc);
    }
  });
  out.content = texts.join("\n");
  if (tcs.length) out.tool_calls = tcs;
  return out;
}

export async function llmChat(env: LlmEnv, messages: Msg[], tools?: unknown, temperature = 0.2): Promise<Msg> {
  const leader = env.MODEL_LEADER?.trim() || DEFAULT_MODELS.leader;
  const fallback = env.MODEL_FALLBACK?.trim() || DEFAULT_MODELS.fallback;
  try {
    return await runChain(env, [leader, fallback], messages, tools, temperature);
  } catch (e) {
    const nimErr = String(e instanceof Error ? e.message : e);
    if (!env.GOOGLE_API_KEY) throw e; // no cross-provider key configured: NIM verdict stands
    const gModel = env.GOOGLE_MODEL_FALLBACK?.trim() || DEFAULT_MODELS.googleFallback;
    console.warn(`llm: NIM chain exhausted, trying cross-provider fallback ${gModel}`);
    // Gemini attempt policy (reviewer-bounded): exactly ONE retry, and only for
    // transient 5xx (a live 503 UNAVAILABLE ended a staging job that later passed
    // untouched). 429 (daily free-tier quota) and other 4xx stay single-attempt.
    // Backoff: Retry-After honored only up to a 5s cap; default 5s.
    let firstErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await geminiOnce(env.GOOGLE_API_KEY, gModel, messages, tools, temperature);
      } catch (ge) {
        const gErr = String(ge instanceof Error ? ge.message : ge);
        console.warn(`llm model failed: ${gModel}: ${gErr.slice(0, 300)}`);
        if (attempt === 0 && /Gemini 5\d\d/.test(gErr)) {
          firstErr = gErr.slice(0, 80);
          const waitSec = Math.min(((ge as { retryAfter?: number })?.retryAfter) ?? 5, 5);
          console.warn(`llm: ${gModel} transient 5xx; single retry in ${waitSec}s`);
          await sleep(waitSec * 1000);
          continue;
        }
        const agg = attempt === 0
          ? `${nimErr} | ${gModel}: ${gErr.slice(0, 120)}`
          : `${nimErr} | ${gModel}: ${firstErr} | retry#1: ${gErr.slice(0, 120)}`;
        throw new Error(agg);
      }
    }
    throw new Error("unreachable");
  }
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

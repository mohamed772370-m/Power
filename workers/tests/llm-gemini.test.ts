import test from "node:test";
import assert from "node:assert/strict";
import { llmChat, toGeminiContents } from "../src/llm.ts";

// History shape mirrors real job state: assistant called "act", but the tool
// result was renamed "browser_step" (agent.ts:482). One call carries a Gemini
// thought signature; the other (NIM-written) does not.
const mixedHistory = [
  { role: "system", content: "sys prompt" },
  { role: "user", content: "goal" },
  { role: "assistant", content: "", tool_calls: [
    { id: "c1", type: "function", function: { name: "act", arguments: "{\"a\":1}" }, thought_signature: "SIG-LIVE" },
  ] },
  { role: "tool", tool_call_id: "c1", name: "browser_step", content: "clicked" },
  { role: "assistant", content: "", tool_calls: [
    { id: "c2", type: "function", function: { name: "act", arguments: "{\"a\":2}" } },
  ] },
  { role: "tool", tool_call_id: "c2", name: "browser_step", content: "typed" },
];

test("gemini converter: functionResponse pairs BY ORIGINAL CALL NAME via tool_call_id, not the renamed result name", () => {
  const { contents } = toGeminiContents(mixedHistory);
  const responses = (contents as any[]).flatMap((c) => c.parts).filter((p) => p.functionResponse);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].functionResponse.name, "act"); // NOT "browser_step"
  assert.equal(responses[1].functionResponse.name, "act");
});

test("gemini converter: captured signature replayed verbatim, foreign call gets bypass token", () => {
  const { contents } = toGeminiContents(mixedHistory);
  const calls = (contents as any[]).flatMap((c) => c.parts).filter((p) => p.functionCall);
  assert.equal(calls[0].thought_signature, "SIG-LIVE");
  assert.equal(calls[1].thought_signature, "skip_thought_signature_validator");
});

test("gemini converter: system->systemInstruction, roles mapped", () => {
  const { system, contents } = toGeminiContents(mixedHistory);
  assert.equal(system, "sys prompt");
  const roles = (contents as any[]).map((c) => c.role);
  assert.deepEqual(roles, ["user", "model", "user", "model", "user"]);
});

test("NIM body strips thought_signature (outbound only), stored state keeps it", async () => {
  const real = globalThis.fetch;
  let sentBody = "";
  globalThis.fetch = (async (_u: any, init: any) => {
    sentBody = init.body as string;
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
  }) as any;
  try {
    const msgs = [{ role: "assistant", content: "", tool_calls: [
      { id: "c9", type: "function", function: { name: "act", arguments: "{}" }, thought_signature: "SIG-KEEP" }] }];
    await llmChat({ NVIDIA_API_KEY: "k" } as any, msgs, undefined);
    assert.ok(!sentBody.includes("thought_signature"), "NIM body must not carry thought_signature");
    assert.equal((msgs[0].tool_calls[0] as any).thought_signature, "SIG-KEEP", "stored state keeps the signature");
  } finally { globalThis.fetch = real; }
});

test("cross-provider: NIM chain fails -> Gemini called with resolved names + header; response shape converted", async () => {
  const real = globalThis.fetch;
  let geminiBody: any = null; let geminiKey: string | null = null;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      geminiKey = (init.headers as any)["x-goog-api-key"];
      geminiBody = JSON.parse(init.body as string);
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [
        { functionCall: { name: "finish", args: { result: "done" } }, thoughtSignature: "SIG-NEW" }] } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: 403, detail: "Authorization failed" }), { status: 403 });
  }) as any;
  try {
    const res = await llmChat({ NVIDIA_API_KEY: "bad", GOOGLE_API_KEY: "gkey", MODEL_LEADER: "m/l", MODEL_FALLBACK: "m/f" } as any, mixedHistory, undefined);
    assert.equal(geminiKey, "gkey");
    const responses = geminiBody.contents.flatMap((c: any) => c.parts).filter((p: any) => p.functionResponse);
    assert.equal(responses[0].functionResponse.name, "act", "live call path resolves renamed result");
    assert.equal((res.tool_calls![0] as any).function.name, "finish");
    assert.equal((res.tool_calls![0] as any).thought_signature, "SIG-NEW", "new signature captured for replay");
  } finally { globalThis.fetch = real; }
});

test("no GOOGLE_API_KEY: NIM verdict stands, Gemini never called", async () => {
  const real = globalThis.fetch;
  let geminiCalled = false;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("generativelanguage")) geminiCalled = true;
    return new Response(JSON.stringify({ status: 403, detail: "x" }), { status: 403 });
  }) as any;
  try {
    await assert.rejects(llmChat({ NVIDIA_API_KEY: "bad", MODEL_LEADER: "m/l", MODEL_FALLBACK: "m/f" } as any, [{ role: "user", content: "x" }], undefined));
    assert.equal(geminiCalled, false);
  } finally { globalThis.fetch = real; }
});

// Bounded 5xx retry policy (reviewer terms): ONE retry on 5xx only, ~5s capped
// backoff, 429/4xx single-attempt, aggregate names the retry.
function mockGeminiSeq(seq: Response[]) {
  const real = globalThis.fetch;
  let geminiCalls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    const u = String(url);
    if (u.includes("generativelanguage.googleapis.com")) {
      geminiCalls++;
      return seq[Math.min(geminiCalls - 1, seq.length - 1)];
    }
    return new Response(JSON.stringify({ status: 403, detail: "x" }), { status: 403 });
  }) as any;
  return { calls: () => geminiCalls, restore: () => { globalThis.fetch = real; } };
}
const geminiOk = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }), { status: 200 });
const geminiErr = (code: number, ra?: string) => new Response(JSON.stringify({ error: { code, message: "m" } }),
  { status: code, headers: ra ? { "retry-after": ra } : {} });
const retryEnv = { NVIDIA_API_KEY: "bad", GOOGLE_API_KEY: "gkey", MODEL_LEADER: "m/l", MODEL_FALLBACK: "m/f" } as any;

test("gemini 503 then 200: ONE retry succeeds", async () => {
  const fx = mockGeminiSeq([geminiErr(503, "1"), geminiOk()]);
  const t0 = Date.now();
  try {
    const res = await llmChat(retryEnv, [{ role: "user", content: "x" }], undefined);
    assert.equal(res.content, "ok");
    assert.equal(fx.calls(), 2);
    assert.ok(Date.now() - t0 >= 900, "actually waited for backoff");
  } finally { fx.restore(); }
});

test("gemini 429: NO retry (daily quota wall)", async () => {
  const fx = mockGeminiSeq([geminiErr(429)]);
  try {
    await assert.rejects(llmChat(retryEnv, [{ role: "user", content: "x" }], undefined), (e: Error) => {
      assert.ok(e.message.includes("gemini") && e.message.includes("429"), `got: ${e.message}`);
      assert.ok(!e.message.includes("retry#1"), "429 must not be retried");
      return true;
    });
    assert.equal(fx.calls(), 1);
  } finally { fx.restore(); }
});

test("gemini 503-503: terminates, aggregate names the retry", async () => {
  const fx = mockGeminiSeq([geminiErr(503, "1"), geminiErr(503)]);
  try {
    await assert.rejects(llmChat(retryEnv, [{ role: "user", content: "x" }], undefined), (e: Error) => {
      assert.ok(e.message.includes("retry#1"), `aggregate names the retry: ${e.message}`);
      assert.ok(e.message.includes("503"), `names the failure: ${e.message}`);
      return true;
    });
    assert.equal(fx.calls(), 2);
  } finally { fx.restore(); }
});

test("backoff: Retry-After honored only up to the 5s cap", async () => {
  const fx = mockGeminiSeq([geminiErr(503, "60"), geminiOk()]); // server asks 60s
  const t0 = Date.now();
  try {
    await llmChat(retryEnv, [{ role: "user", content: "x" }], undefined);
    const waited = Date.now() - t0;
    assert.ok(waited >= 4500, `fixed backoff happened (${waited}ms)`);
    assert.ok(waited < 15000, `Retry-After 60s was capped, not honored (${waited}ms)`);
  } finally { fx.restore(); }
});

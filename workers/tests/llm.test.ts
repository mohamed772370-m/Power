import test from "node:test";
import assert from "node:assert/strict";
import { llmChat } from "../src/llm.ts";

const env = { NVIDIA_API_KEY: "k" } as any;
const okMsg = { role: "assistant", content: "pong" };
const okRes = () => new Response(JSON.stringify({ choices: [{ message: okMsg }] }), { status: 200 });

function mockFetch(handler: (model: string, n: number) => Response) {
  const counts: Record<string, number> = {};
  const real = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    const model = JSON.parse(init.body).model as string;
    counts[model] = (counts[model] ?? 0) + 1;
    return handler(model, counts[model]);
  }) as any;
  return { counts, restore: () => { globalThis.fetch = real; } };
}

test("llm chain: terminal error aggregates EVERY model's own failure", async () => {
  const fx = mockFetch((model) =>
    model === "test/leader-agg"
      ? new Response(JSON.stringify({ status: 429, title: "Too Many Requests" }), { status: 429, headers: { "retry-after": "0" } })
      : new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 }));
  try {
    const savedL = process.env; // no env overrides; use MODEL_* on env instead
    const e = { ...env, MODEL_LEADER: "test/leader-agg", MODEL_FALLBACK: "test/fallback-agg" };
    await assert.rejects(llmChat(e, [{ role: "user", content: "x" }], undefined), (err: Error) => {
      assert.ok(err.message.includes("test/leader-agg") && err.message.includes("429"), `leader error named, got: ${err.message}`);
      assert.ok(err.message.includes("test/fallback-agg") && err.message.includes("404"), `fallback error named, got: ${err.message}`);
      return true;
    });
    assert.equal(fx.counts["test/fallback-agg"], 1, "404 fallback tried exactly once (no retry on 404)");
  } finally { fx.restore(); }
});

test("llm chain: 429 is retried once after the Retry-After backoff, then succeeds", async () => {
  const fx = mockFetch((model, n) => (n === 1
    ? new Response(JSON.stringify({ status: 429, title: "Too Many Requests" }), { status: 429, headers: { "retry-after": "1" } })
    : okRes()));
  try {
    const e = { ...env, MODEL_LEADER: "test/leader-429", MODEL_FALLBACK: "test/fallback-429" };
    const t0 = Date.now();
    const msg = await llmChat(e, [{ role: "user", content: "x" }], undefined);
    assert.equal(msg.content, "pong");
    assert.equal(fx.counts["test/leader-429"], 2, "leader retried exactly once");
    assert.ok(!fx.counts["test/fallback-429"], "fallback never needed");
    assert.ok(Date.now() - t0 >= 900, "honored the ~1s Retry-After backoff");
  } finally { fx.restore(); }
});

test("llm chain: 404 dead-model cache skips the dead model within its TTL", async () => {
  let leaderCalls = 0;
  let allFail = false;
  const fx = mockFetch((model) => {
    if (allFail) return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 });
    if (model === "test/leader-dead") { leaderCalls += 1; return new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404 }); }
    return okRes();
  });
  try {
    const e = { ...env, MODEL_LEADER: "test/leader-dead", MODEL_FALLBACK: "test/fallback-dead" };
    const m1 = await llmChat(e, [{ role: "user", content: "x" }], undefined);
    assert.equal(m1.content, "pong");
    assert.equal(leaderCalls, 1, "first call discovers the 404 once");
    const m2 = await llmChat(e, [{ role: "user", content: "x" }], undefined);
    assert.equal(m2.content, "pong");
    assert.equal(leaderCalls, 1, "second call within TTL skips the dead leader entirely");
    allFail = true;
    await assert.rejects(llmChat({ ...env, MODEL_LEADER: "test/leader-dead" } as any, [{ role: "user", content: "x" }], undefined), /skipped \(dead-model cache/, "with no fallback left, the aggregate names the cache skip");
  } finally { fx.restore(); }
});

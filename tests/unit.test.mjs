import assert from "node:assert/strict";
import { parsePlan, shouldPlan, Semaphore } from "../src/solve.ts";
import { chunkText } from "../src/telegram.ts";
import { loadConfig, missingVars } from "../src/config.ts";
import { RateLimiter, createLlm } from "../src/llm.ts";
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await t("parsePlan: valid parallel / capped / invalid -> single", () => {
  const g = "الهدف";
  assert.deepEqual(parsePlan('{"mode":"parallel","subtasks":[{"goal":"a"},{"goal":"b"}]}', g, 5), { mode: "parallel", subtasks: [{ goal: "a" }, { goal: "b" }] });
  assert.equal(parsePlan('نص قبل {"mode":"parallel","subtasks":[{"goal":"a"},{"goal":"b"},{"goal":"c"}]} بعد', g, 2).subtasks.length, 2);
  for (const bad of ["", "no json", '{"mode":"parallel","subtasks":[{"goal":"only one"}]}', '{"mode":"parallel","subtasks":[{"goal":""},{"goal":" "}]}', '{"mode":"single"}', "{bad json}", '{"mode":"parallel","subtasks":"x"}'])
    assert.deepEqual(parsePlan(bad, g, 5), { mode: "single", subtasks: [{ goal: g }] }, bad);
});
await t("shouldPlan: short goals skip the planner call", () => { assert.equal(shouldPlan("افتح google.com"), false); assert.equal(shouldPlan("x".repeat(70)), true); });
await t("Semaphore: never exceeds N concurrent; release is idempotent", async () => {
  const s = new Semaphore(2); let cur = 0, peak = 0;
  await Promise.all(Array.from({ length: 7 }, async () => { const r = await s.acquire(); cur++; peak = Math.max(peak, cur); await sleep(20); cur--; r(); r(); }));
  assert.equal(peak, 2);
  const r1 = await s.acquire(); const r2 = await s.acquire(); r1(); r1(); r2(); assert.equal((await Promise.all([s.acquire(), s.acquire()])).length, 2);
});
await t("chunkText: splits long text on newlines under the limit, never loses content", () => {
  const long = Array.from({ length: 300 }, (_, i) => "سطر رقم " + i).join("\n"); const parts = chunkText(long, 500);
  assert.ok(parts.length > 3 && parts.every((p) => p.length <= 500)); assert.equal(parts.join("\n"), long); assert.deepEqual(chunkText(""), ["(فارغ)"]);
});
await t("config: required vars, ids parsing, derived webhook secret follows the token, Render url", () => {
  assert.deepEqual(missingVars({}), ["TELEGRAM_BOT_TOKEN", "NVIDIA_API_KEY", "ADMIN_TELEGRAM_ID", "KERNEL_API_KEY (أو STEEL_API_KEY)"]);
  assert.throws(() => loadConfig({ TELEGRAM_BOT_TOKEN: "a" }), /ناقصة/);
  const env = { TELEGRAM_BOT_TOKEN: " tok1 ", NVIDIA_API_KEY: "k", ADMIN_TELEGRAM_ID: "42", ALLOWED_USER_IDS: "7, x ,9", STEEL_API_KEY: "s", RENDER_EXTERNAL_URL: "https://a.onrender.com/", PORT: "8080", MAX_PARALLEL: "5" };
  const c = loadConfig(env); assert.deepEqual([...c.allowedIds], [42, 7, 9]); assert.equal(c.publicUrl, "https://a.onrender.com"); assert.equal(c.port, 8080); assert.equal(c.maxParallel, 5); assert.equal(c.telegramToken, "tok1");
  assert.notEqual(loadConfig({ ...env, TELEGRAM_BOT_TOKEN: "tok2" }).webhookSecret, c.webhookSecret); assert.equal(loadConfig({ ...env, WEBHOOK_SECRET: "mine" }).webhookSecret, "mine");
  assert.throws(() => loadConfig({ ...env, ADMIN_TELEGRAM_ID: "abc", ALLOWED_USER_IDS: "" }), /رقماً/);
});
await t("RateLimiter: window enforced", async () => {
  const r = new RateLimiter(3, 150); const t0 = Date.now(); for (let i = 0; i < 4; i++) await r.acquire(); const ms = Date.now() - t0;
  assert.ok(ms >= 140 && ms < 400, "4th call waited for the window: " + ms);
});
await t("llm: retry on 500, fallback model, dead model (404) skipped afterwards, vision uses vision model", async () => {
  const seen = []; let mode = "retry";
  const fetchFn = async (_u, init) => {
    const b = JSON.parse(init.body); seen.push(b.model);
    if (mode === "retry" && seen.length === 1) return new Response("boom", { status: 500 });
    if (mode === "dead" && b.model === "L") return new Response("nf", { status: 404 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok:" + b.model } }] }), { headers: { "content-type": "application/json" } });
  };
  const llm = createLlm({ apiKey: "k", fetchFn, retryDelayMs: 1, models: { leader: "L", fallback: "F", vision: "V", visionFallback: "VF" } });
  assert.equal((await llm.chat([{ role: "user", content: "x" }])).content, "ok:L"); assert.deepEqual(seen, ["L", "L"]);
  mode = "dead"; seen.length = 0;
  assert.equal((await llm.chat([{ role: "user", content: "x" }])).content, "ok:F"); assert.deepEqual(seen, ["L", "F"]);
  seen.length = 0; await llm.chat([{ role: "user", content: "y" }]); assert.deepEqual(seen, ["F"], "dead model not retried");
  assert.equal(await llm.vision("QQ", "q"), "ok:V");
  const bad = createLlm({ apiKey: "k", fetchFn: async () => new Response("x", { status: 500 }), retryDelayMs: 1 });
  await assert.rejects(() => bad.chat([{ role: "user", content: "x" }]), /NIM 500/);
});
console.log(`\n${n} unit test groups passed`);

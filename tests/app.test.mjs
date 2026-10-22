import assert from "node:assert/strict";
import { start } from "./real/server.mjs"; import { launch, pptr } from "./real/harness.mjs";
import { makeWorld, update, waitFor, sleep, TOKEN, SECRET } from "./world.mjs";
import { loadConfig } from "../src/config.ts"; import { createApp } from "../src/app.ts";
const { srv, base } = await start(); const chrome = await launch();
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };
const mk = async ({ latency = 0, env = {}, publicUrl = "https://bot.example.com", over = {} } = {}) => {
  const w = makeWorld({ chrome, base, latency });
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: TOKEN, NVIDIA_API_KEY: "k", ADMIN_TELEGRAM_ID: "1", KERNEL_API_KEY: "kk", WEBHOOK_SECRET: SECRET, ...env });
  cfg.port = 0; cfg.publicUrl = publicUrl;
  const app = createApp(cfg, { fetchFn: w.fetchFn, loadPuppeteer: async () => pptr, kernelBase: "https://api.onkernel.com", statusThrottleMs: 40, log: () => {}, steel: { configured: () => false, create: async () => { throw new Error("n/a"); }, destroy: async () => {} }, ...over });
  const port = await app.start(); return { w, app, port, cfg };
};
const idle = (app) => waitFor(() => app.bot.jobs.size === 0, 30000);
const THREE = `افتح هذه الصفحات الثلاث وأعد عنوان كل صفحة منها: ${base}/about و ${base}/deep و ${base}/popup`;
try {
  await t("webhook mode: registers webhook with secret; /health ok; bad secret -> 403; good secret -> 200", async () => {
    const { w, app, port } = await mk(); await waitFor(() => w.tg.some((x) => x.method === "setWebhook"));
    const sw = w.tg.find((x) => x.method === "setWebhook"); assert.equal(sw.url, "https://bot.example.com/telegram"); assert.equal(sw.secret_token, SECRET);
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json(); assert.equal(h.ok, true);
    assert.equal((await fetch(`http://127.0.0.1:${port}/telegram`, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/telegram`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": "wrong" }, body: "{}" })).status, 403);
    const ok = await fetch(`http://127.0.0.1:${port}/telegram`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": SECRET }, body: JSON.stringify(update("/start")) }); assert.equal(ok.status, 200);
    await waitFor(() => w.sent().some((x) => x.includes("وكيل تصفح"))); assert.equal((await fetch(`http://127.0.0.1:${port}/nope`)).status, 404); await app.stop();
  });

  await t("owner-only: stranger gets one refusal and starts nothing", async () => {
    const { w, app } = await mk(); await app.bot.handleUpdate(update("افتح " + base + "/about", 999, 999)); await app.bot.handleUpdate(update("again", 999, 999));
    assert.deepEqual(w.sent(), ["⛔ هذا البوت خاص."]); assert.equal(w.nim.length, 0); assert.equal(w.kernel.created, 0); await app.stop();
  });

  await t("PARALLEL: 3 independent pages -> plan -> 3 real browser sessions -> synthesis; sessions all released", async () => {
    const { w, app } = await mk(); await app.bot.handleUpdate(update(THREE)); await idle(app);
    const final = w.sent().at(-1); console.log("   final:", final.replace(/\n/g, " | ").slice(0, 160));
    for (const title of ["About", "Deep", "Help Popup"]) assert.ok(final.includes(title), title);
    assert.ok(final.startsWith("الخلاصة النهائية"));
    assert.equal(w.planCalls, 1); assert.equal(w.synthCalls, 1); assert.equal(w.kernel.created, 3); assert.equal(w.kernel.deleted, 3); assert.equal(w.kernel.peak, 3);
    const edits = w.edits().join("\n"); assert.ok(edits.includes("[1/3]") && edits.includes("[3/3]"), "per-subtask status visible"); assert.ok(w.edits().at(-1).startsWith("✅ انتهت المهمة"));
    await app.stop();
  });

  await t("SPEED: same 3-page task, MAX_PARALLEL=1 vs 3 (stub LLM latency 400ms, real browser)", async () => {
    const run = async (par) => { const { w, app } = await mk({ latency: 400, env: { MAX_PARALLEL: String(par) } }); const s = Date.now(); await app.bot.handleUpdate(update(THREE)); await idle(app); const ms = Date.now() - s; assert.equal(w.kernel.created, 3); assert.ok(w.kernel.peak <= par); await app.stop(); return ms; };
    const seq = await run(1); const par = await run(3);
    console.log(`   sequential: ${seq}ms | parallel(3): ${par}ms | speedup x${(seq / par).toFixed(2)}`); assert.ok(seq / par > 1.6);
  });

  await t("short single task skips the planner and uses exactly one session", async () => {
    const { w, app } = await mk(); await app.bot.handleUpdate(update(`افتح ${base}/about`)); await idle(app);
    assert.equal(w.planCalls, 0); assert.equal(w.kernel.created, 1); assert.equal(w.kernel.deleted, 1); assert.ok(w.sent().at(-1).startsWith("✅ عنوان الصفحة: About"), w.sent().at(-1)); await app.stop();
  });

  await t("evidence grounding: fabricated evidence is challenged once, then the real quote is accepted", async () => {
    const { w, app } = await mk(); await app.bot.handleUpdate(update(`افتح ${base}/deep وهذا اختبار fake-evidence`)); await idle(app);
    assert.equal(w.nim.filter((x) => x === "sub").length, 3, "goto, bad finish, good finish"); const f = w.sent().at(-1);
    assert.ok(f.startsWith("✅ عنوان الصفحة: Deep") && !f.includes("لم يُتحقق"), f); await app.stop();
  });

  await t("one job per chat; second message is refused; /stop aborts and releases the browser", async () => {
    const { w, app } = await mk({ latency: 150 }); await app.bot.handleUpdate(update(`افتح ${base}/about stuck-test`));
    await waitFor(() => w.kernel.created === 1 && w.nim.filter((x) => x === "sub").length >= 3);
    await app.bot.handleUpdate(update("مهمة ثانية")); assert.ok(w.sent().some((x) => x.includes("عندي مهمة جارية")));
    await app.bot.handleUpdate(update("/stop")); await idle(app);
    assert.ok(w.sent().some((x) => x.includes("جارٍ إيقاف"))); assert.ok(w.edits().at(-1).startsWith("⛔ أُوقفت")); assert.ok(w.sent().at(-1).includes("أُوقفت المهمة"));
    assert.equal(w.kernel.deleted, w.kernel.created); await app.bot.handleUpdate(update("/stop")); assert.ok(w.sent().at(-1).includes("لا توجد مهمة جارية")); await app.stop();
  });

  await t("follow-up keeps short history for the next request", async () => {
    const { w, app } = await mk(); await app.bot.handleUpdate(update(`افتح ${base}/about`)); await idle(app);
    await app.bot.handleUpdate(update(`افتح ${base}/deep`)); await idle(app);
    assert.ok(!w.subTasks[0].includes("سياق المحادثة السابقة")); assert.ok(w.subTasks[1].includes("سياق المحادثة السابقة") && w.subTasks[1].includes("About"), w.subTasks[1].slice(0, 200)); await app.stop();
  });

  await t("polling mode (no public URL): receives updates via getUpdates and stops cleanly", async () => {
    const { w, app } = await mk({ publicUrl: "" }); await waitFor(() => w.tg.some((x) => x.method === "deleteWebhook"));
    w.updatesQueue.push(update("/help")); await waitFor(() => w.sent().some((x) => x.includes("وكيل تصفح")));
    const s = Date.now(); await app.stop(); assert.ok(Date.now() - s < 3000, "stop is prompt");
  });
} finally { await chrome.close(); srv.close(); }
console.log(`\n${n} app test groups passed`); process.exit(0);

// web-agent on Cloudflare Workers (free plan), queue-chained architecture:
//   POST /telegram (webhook, secret-token verified) -> stores job state in KV
//   and enqueues ONE message. Each queue delivery is a genuinely fresh Worker
//   invocation with its own 50-subrequest budget (measured: a Workflow
//   instance's budget is per instance - 51st fetch fails regardless of sleeps,
//   probe-1792734234866). The consumer runs up to 4 state-machine units, saves
//   state, and re-enqueues until the job is done.
//   GET /health -> liveness. GET /last -> last job evidence (secret-keyed).
// deno-lint-ignore-file no-explicit-any
import { createTelegram } from "./tg.ts";
import {
  initJobState, stepPlan, stepLlm, stepTool, stepNextSubtask, stepSynth, destroySession,
  type JobState,
} from "./agent.ts";

export interface Env {
  JOBS: KVNamespace;
  JOBS_QUEUE: Queue;
  ADMIN_TELEGRAM_ID: string;
  TELEGRAM_BOT_TOKEN: string;
  NVIDIA_API_KEY: string;
  KERNEL_API_KEY?: string;
  STEEL_API_KEY?: string;
  WEBHOOK_SECRET: string;
  MODEL_LEADER?: string;
  MODEL_FALLBACK?: string;
  MODEL_VISION?: string;
}

export const HELP_TEXT =
  "👋 أنا وكيل تصفح. أرسل لي أي مهمة على الإنترنت بنص عادي وسأنفذها وأعيد لك النتيجة.\n\n" +
  "أمثلة:\n• قارن أسعار هذا المنتج في 3 مواقع: …\n• افتح الرابط … واستخرج الجدول\n• ادخل الموقع … واملأ النموذج بهذه البيانات\n\n" +
  "إن كانت المهمة تتكون من أجزاء مستقلة قسّمتها ونفّذتها بالتوازي لأسرع.\n/stop إيقاف المهمة الجارية\n/help هذه الرسالة";

const UNITS_PER_INVOCATION = 4;

function historyText(h: Array<{ goal: string; answer: string }>): string {
  return h.length
    ? "سياق المحادثة السابقة (للمتابعة فقط):\n" + h.map((x) => `- الطلب: ${x.goal.slice(0, 300)}\n  النتيجة: ${x.answer.slice(0, 700)}`).join("\n")
    : "";
}

async function runUnits(env: Env, jobId: string): Promise<void> {
  const tg = createTelegram(env.TELEGRAM_BOT_TOKEN);
  const raw = await env.JOBS.get(`state:${jobId}`);
  if (!raw) return; // deleted (stopped or already delivered)
  if (await env.JOBS.get(`stopped:${jobId}`)) {
    // stopped while a message was in flight: clean up quietly
    try {
      const st = JSON.parse(raw) as JobState;
      if (st.browser) await destroySession(env as any, st.browser);
    } catch { /* best effort */ }
    await env.JOBS.delete(`state:${jobId}`).catch(() => {});
    await env.JOBS.delete(`stopped:${jobId}`).catch(() => {});
    return;
  }
  let st = JSON.parse(raw) as JobState;
  try {
    for (let i = 0; i < UNITS_PER_INVOCATION && st.next !== "done"; i++) {
      if (!st.plan) st = await stepPlan(env as any, st);
      else if (st.next === "llm") st = await stepLlm(env as any, st);
      else if (st.next === "tool") st = await stepTool(env as any, st, tg);
      else if (st.next === "nextsub") st = await stepNextSubtask(env as any, st);
      else if (st.next === "synth") st = await stepSynth(env as any, st);
    }
  } catch (e) {
    st.finalText = `❌ تعذّر إكمال المهمة: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
    st.next = "done";
  }
  if (st.next !== "done") {
    await env.JOBS.put(`state:${jobId}`, JSON.stringify(st), { expirationTtl: 3600 });
    await env.JOBS_QUEUE.send({ jobId });
    return;
  }
  // deliver
  const ok = !st.finalText.startsWith("❌");
  const secs = Math.round((Date.now() - st.startedAt) / 1000);
  if (st.statusMsgId) await tg.editMessage(st.chatId, st.statusMsgId, `${ok ? "✅ انتهت" : "❌ فشلت"} المهمة (${secs}ث)`).catch(() => {});
  await tg.sendMessage(st.chatId, st.finalText || "(لا نتيجة)").catch(() => {});
  try {
    const key = `hist:${st.chatId}`;
    const arr = JSON.parse((await env.JOBS.get(key)) ?? "[]");
    if (ok) { arr.push({ goal: st.goal, answer: st.finalText }); await env.JOBS.put(key, JSON.stringify(arr.slice(-3))); }
  } catch { /* history is best effort */ }
  await env.JOBS.put(`last:${st.chatId}`, JSON.stringify({
    ok, text: st.finalText, ms: Date.now() - st.startedAt, lines: st.statusLines.slice(-12), at: Date.now(),
  })).catch(() => {});
  if (st.browser) await destroySession(env as any, st.browser).catch(() => {});
  await env.JOBS.delete(`state:${jobId}`).catch(() => {});
  await env.JOBS.delete(`job:${st.chatId}`).catch(() => {});
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({ ok: true, worker: "web-agent", mode: "queue-chained", ts: Date.now() });
    }
    if (request.method === "GET" && url.pathname === "/last") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const chatId = url.searchParams.get("chat") ?? env.ADMIN_TELEGRAM_ID.split(",")[0].trim();
      const v = await env.JOBS.get(`last:${chatId}`);
      return new Response(v ?? "null", { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    if (request.method === "POST" && url.pathname === "/telegram") {
      if (request.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let update: any;
      try { update = await request.json(); } catch { return new Response("bad body", { status: 400 }); }
      const msg = update?.message;
      if (!msg) return Response.json({ ok: true });
      const chatId: number = msg.chat?.id;
      const from: number = msg.from?.id;
      if (!chatId || !from) return Response.json({ ok: true });
      const tg = createTelegram(env.TELEGRAM_BOT_TOKEN);
      const allowed = new Set(env.ADMIN_TELEGRAM_ID.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n)));
      if (!allowed.has(from)) {
        await tg.sendMessage(chatId, "⛔ هذا البوت خاص.").catch(() => {});
        return Response.json({ ok: true });
      }
      const text = String(msg.text ?? "").trim();
      if (!text) { await tg.sendMessage(chatId, "أرسل المهمة كنص من فضلك.").catch(() => {}); return Response.json({ ok: true }); }
      const cmd = text.split(/[\s@]/)[0].toLowerCase();
      if (cmd === "/start" || cmd === "/help") { await tg.sendMessage(chatId, HELP_TEXT).catch(() => {}); return Response.json({ ok: true }); }
      if (cmd === "/stop") {
        const jobId = await env.JOBS.get(`job:${chatId}`);
        if (!jobId) { await tg.sendMessage(chatId, "لا توجد مهمة جارية.").catch(() => {}); return Response.json({ ok: true }); }
        await env.JOBS.put(`stopped:${jobId}`, "1", { expirationTtl: 3600 });
        // best-effort immediate browser cleanup
        try {
          const raw = await env.JOBS.get(`state:${jobId}`);
          if (raw) { const st = JSON.parse(raw); if (st.browser) await destroySession(env as any, st.browser); }
        } catch { /* in flight */ }
        await tg.sendMessage(chatId, "⛔ أُوقفت المهمة.").catch(() => {});
        return Response.json({ ok: true });
      }
      if (text.startsWith("/")) { await tg.sendMessage(chatId, "أمر غير معروف. أرسل /help").catch(() => {}); return Response.json({ ok: true }); }
      // a browsing job
      if (await env.JOBS.get(`job:${chatId}`)) {
        await tg.sendMessage(chatId, "⏳ عندي مهمة جارية. انتظرها أو أرسل /stop لإيقافها.").catch(() => {});
        return Response.json({ ok: true });
      }
      let history: Array<{ goal: string; answer: string }> = [];
      try { history = JSON.parse((await env.JOBS.get(`hist:${chatId}`)) ?? "[]"); } catch { history = []; }
      const statusMsgId = await tg.sendMessage(chatId, "⏳ بدأتُ العمل على المهمة…").catch(() => 0);
      const jobId = `job-${chatId}-${Date.now()}`;
      const st = initJobState(chatId, text, historyText(history), statusMsgId);
      await env.JOBS.put(`state:${jobId}`, JSON.stringify(st), { expirationTtl: 3600 });
      await env.JOBS.put(`job:${chatId}`, jobId, { expirationTtl: 3600 });
      await env.JOBS_QUEUE.send({ jobId });
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const { jobId } = message.body as { jobId: string };
        await runUnits(env, jobId);
        message.ack();
      } catch (e) {
        console.error("queue unit failed:", e);
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;

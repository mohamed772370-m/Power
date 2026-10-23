// web-agent on Cloudflare Workers (free plan):
//   POST /telegram (webhook, secret-token verified) -> starts one Workflow
//   instance per browsing job; the job's browse loop runs one LLM call or one
//   tool action per Workflow step, so every step gets a fresh 10ms CPU + 50
//   subrequest budget with unlimited wall clock for I/O waits.
//   GET /health -> liveness.
// deno-lint-ignore-file no-explicit-any
import { WorkflowEntrypoint } from "cloudflare:workers";
import { createTelegram } from "./tg.ts";
import {
  initJobState, stepPlan, stepLlm, stepTool, stepNextSubtask, stepSynth, destroySession,
  type JobState,
} from "./agent.ts";

export interface Env {
  JOBS: KVNamespace;
  WEB_AGENT_WORKFLOW: any;
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

interface Params { chatId: number; goal: string; history: string; statusMsgId: number }

const RETRY = { retries: { limit: 2, delay: "3 seconds", backoff: "exponential" } } as any;

export class WebAgentWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: any, step: any) {
    const env = this.env;
    const tg = createTelegram(env.TELEGRAM_BOT_TOKEN);
    const { chatId, goal, history, statusMsgId } = event.payload as Params;
    let st: JobState = initJobState(chatId, goal, history, statusMsgId);
    let ok = true;
    try {
      st = await step.do("plan", RETRY, () => stepPlan(env as any, st));
      let guard = 0;
      while (st.next !== "done" && guard++ < 500) {
        if (st.next === "llm") st = await step.do(`llm-${st.subIdx}-${st.step}`, RETRY, () => stepLlm(env as any, st));
        else if (st.next === "tool") st = await step.do(`tool-${st.subIdx}-${st.step}-${st.pendingTools.length}`, RETRY, () => stepTool(env as any, st, tg));
        else if (st.next === "nextsub") st = await step.do(`nextsub-${st.subIdx}`, () => stepNextSubtask(env as any, st));
        else if (st.next === "synth") st = await step.do("synth", RETRY, () => stepSynth(env as any, st));
        // Workflows co-runs consecutive steps in ONE invocation, sharing the
        // 50-subrequest free-plan budget (measured failure: "Too many
        // subrequests"). A 1s sleep forces the engine into a fresh invocation
        // with a fresh budget every 3 work steps.
        if (st.next !== "done" && guard % 3 === 0) await step.sleep(`yield-${guard}`, "5 seconds");
      }
      if (st.next !== "done") { ok = false; st.finalText = "❌ تجاوزت المهمة حد الخطوات الداخلي."; }
    } catch (e) {
      ok = false;
      st.finalText = `❌ تعذّر إكمال المهمة: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
    }
    await step.do("deliver", RETRY, async () => {
      const secs = Math.round((Date.now() - st.startedAt) / 1000);
      if (st.statusMsgId) await tg.editMessage(chatId, st.statusMsgId, `${ok ? "✅ انتهت" : "❌ فشلت"} المهمة (${secs}ث)`).catch(() => {});
      await tg.sendMessage(chatId, st.finalText || "(لا نتيجة)").catch(() => {});
      const key = `hist:${chatId}`;
      try {
        const arr = JSON.parse((await env.JOBS.get(key)) ?? "[]");
        if (ok) { arr.push({ goal, answer: st.finalText }); await env.JOBS.put(key, JSON.stringify(arr.slice(-3))); }
      } catch { /* history is best effort */ }
      await env.JOBS.delete(`job:${chatId}`).catch(() => {});
      if (st.browser) await destroySession(env as any, st.browser);
      // evidence for testing/ops: last job result per chat
      await env.JOBS.put(`last:${chatId}`, JSON.stringify({ ok, text: st.finalText, ms: Date.now() - st.startedAt, lines: st.statusLines.slice(-12), at: Date.now() })).catch(() => {});
    });
    return { ok, text: st.finalText.slice(0, 500) };
  }
}

function historyText(h: Array<{ goal: string; answer: string }>): string {
  return h.length
    ? "سياق المحادثة السابقة (للمتابعة فقط):\n" + h.map((x) => `- الطلب: ${x.goal.slice(0, 300)}\n  النتيجة: ${x.answer.slice(0, 700)}`).join("\n")
    : "";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({ ok: true, worker: "web-agent", ts: Date.now() });
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
        const instanceId = await env.JOBS.get(`job:${chatId}`);
        if (!instanceId) { await tg.sendMessage(chatId, "لا توجد مهمة جارية.").catch(() => {}); return Response.json({ ok: true }); }
        try {
          const inst = await env.WEB_AGENT_WORKFLOW.get(instanceId);
          await inst.terminate();
        } catch { /* already gone */ }
        await env.JOBS.delete(`job:${chatId}`).catch(() => {});
        await tg.sendMessage(chatId, "⛔ أُوقفت المهمة.").catch(() => {});
        return Response.json({ ok: true });
      }
      if (text.startsWith("/")) { await tg.sendMessage(chatId, "أمر غير معروف. أرسل /help").catch(() => {}); return Response.json({ ok: true }); }
      // a browsing job
      const existing = await env.JOBS.get(`job:${chatId}`);
      if (existing) {
        let running = false;
        try {
          const inst = await env.WEB_AGENT_WORKFLOW.get(existing);
          const status = await inst.status();
          running = ["queued", "running", "waiting", "paused", "unknown"].includes(String(status?.status ?? status));
        } catch { /* stale pointer */ }
        if (running) { await tg.sendMessage(chatId, "⏳ عندي مهمة جارية. انتظرها أو أرسل /stop لإيقافها.").catch(() => {}); return Response.json({ ok: true }); }
        await env.JOBS.delete(`job:${chatId}`).catch(() => {});
      }
      let history: Array<{ goal: string; answer: string }> = [];
      try { history = JSON.parse((await env.JOBS.get(`hist:${chatId}`)) ?? "[]"); } catch { history = []; }
      const statusMsgId = await tg.sendMessage(chatId, "⏳ بدأتُ العمل على المهمة…").catch(() => 0);
      const id = `job-${chatId}-${Date.now()}`;
      try {
        await env.WEB_AGENT_WORKFLOW.create({
          id,
          params: { chatId, goal: text, history: historyText(history), statusMsgId } satisfies Params,
        });
        await env.JOBS.put(`job:${chatId}`, id, { expirationTtl: 3600 });
      } catch (e) {
        await tg.sendMessage(chatId, `❌ تعذّر بدء المهمة: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`).catch(() => {});
      }
      return Response.json({ ok: true });
    }
    if (request.method === "GET" && url.pathname === "/last") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("forbidden", { status: 403 });
      const chatId = url.searchParams.get("chat") ?? env.ADMIN_TELEGRAM_ID.split(",")[0].trim();
      const v = await env.JOBS.get(`last:${chatId}`);
      return new Response(v ?? "null", { headers: { "content-type": "application/json; charset=utf-8" } });
    }
    return new Response("not found", { status: 404 });
  },
};

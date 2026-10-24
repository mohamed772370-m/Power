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
  applyConfirmation, initJobState, stepPlan, stepLlm, stepTool, stepNextSubtask, stepSynth, destroySession, JOB_TIMEOUT_MS,
  type JobState,
} from "./agent.ts";
import type { Telegram } from "./tg.ts";


export interface Env {
  // STAGING-ONLY test hook (review artifact): never present in the production
  // worker's vars/secrets. Modes: "probe404" = the kernel liveness probe behaves
  // as if the session is gone (exercises dead-session termination live without
  // destroying any real session); "deliver-fail-once" = the terminal deliver
  // step throws once per job (exercises queue retry -> recovery of the
  // outside-the-unit-loop failure class suspected in the run2 livelock);
  // "stale-snapshot" = one delivery per job runs on the first delivery's
  // state generation; "stale-snapshot-resume" = the generation captured right
  // after a decision is applied (unconsumed approvedAction) is replayed once
  // by a later delivery - the decisive stale-approval-vs-done-ledger case.
  // Fault keys are TTL'd writes only; nothing is deleted.
  STAGING_FAULT?: string;
  JOBS: KVNamespace;
  JOBS_QUEUE: Queue;
  ADMIN_TELEGRAM_ID: string;
  TELEGRAM_BOT_TOKEN: string;
  NVIDIA_API_KEY: string;
  KERNEL_API_KEY?: string;
  STEEL_API_KEY?: string;
  WEBHOOK_SECRET: string;
  INTERNAL_TASK_SECRET?: string;
  VAL_CALLBACK_URL?: string;
  VAL_PROCESS_SECRET?: string;

  MODEL_LEADER?: string;
  MODEL_FALLBACK?: string;
  MODEL_VISION?: string;
}

const HELP_TEXT =
  "👋 أنا وكيل تصفح. أرسل لي أي مهمة على الإنترنت بنص عادي وسأنفذها وأعيد لك النتيجة.\n\n" +
  "أمثلة:\n• قارن أسعار هذا المنتج في 3 مواقع: …\n• افتح الرابط … واستخرج الجدول\n• ادخل الموقع … واملأ النموذج بهذه البيانات\n\n" +
  "إن كانت المهمة تتكون من أجزاء مستقلة قسّمتها ونفّذتها بالتوازي لأسرع.\n/stop إيقاف المهمة الجارية\n/help هذه الرسالة";

const UNITS_PER_INVOCATION = 4;

function historyText(h: Array<{ goal: string; answer: string }>): string {
  return h.length
    ? "سياق المحادثة السابقة (للمتابعة فقط):\n" + h.map((x) => `- الطلب: ${x.goal.slice(0, 300)}\n  النتيجة: ${x.answer.slice(0, 700)}`).join("\n")
    : "";
}

// Push a long-task outcome back to the val main bot (/process kind "ltask_result").
// 3 retries like val's own resume pattern; failure is logged, the KV result remains
// the pull fallback. Only for internal jobs that carry callbackChatId.
async function notifyVal(env: Env, st: JobState, payload: Record<string, unknown>): Promise<void> {
  if (!env.VAL_CALLBACK_URL || !env.VAL_PROCESS_SECRET || !st.callbackChatId) return;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${env.VAL_CALLBACK_URL.replace(/\/$/, "")}/process`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // event_id lets the val side dedupe repeated callbacks for the same state (H2).
        body: JSON.stringify({ auth: env.VAL_PROCESS_SECRET, kind: "ltask_result", chat_id: st.callbackChatId, job_id: st.jobId, event_id: `${st.jobId}:${String(payload.status ?? "")}${payload.status === "awaiting_confirmation" ? ":" + String(payload.nonce ?? "") : ""}`, ...payload }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`val /process ${res.status}`);
      return;
    } catch (e) {
      console.error(`notifyVal attempt ${attempt}/3 failed:`, e);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
  // Distinct final-failure log: the KV result remains the pull fallback (val sweep is
  // a documented follow-up; until then a lost callback means a silent task).
  console.error(`notifyVal DELIVERY FAILED for job ${st.jobId} status ${String(payload.status ?? "")} after 3 attempts`);
}

// Internal jobs (origin "internal", chatId 0) have no Telegram chat; all output flows
// to KV `result:` keys readable via GET /task-result. Their telegram handle is a no-op.
const NOOP_TG = {
  sendMessage: async () => 0, editMessage: async () => {}, sendPhoto: async () => {},
} as unknown as Telegram;

async function runUnits(env: Env, jobId: string, decision?: string, decisionNonce?: string): Promise<void> {
  const tg = createTelegram(env.TELEGRAM_BOT_TOKEN);
  let raw = await env.JOBS.get(`state:${jobId}`);
  if (!raw) return; // deleted (stopped or already delivered)
  const faultMode = env.STAGING_FAULT ?? "";
  if (faultMode === "stale-snapshot" || faultMode === "stale-snapshot-resume") {
    // Staging-only fault (review fixture): run ONE delivery per job on a
    // previous state generation, exercising stale-snapshot replay safety
    // (ledger replay / terminal handling). Writes only TTL'd keys.
    // "stale-snapshot": snapshot = the first delivery's state (initial gen).
    // "stale-snapshot-resume": snapshot = the generation captured right AFTER
    // a decision is applied (carries the unconsumed approvedAction) - the
    // decisive replay case: stale approval vs an already-done ledger.
    const snapKey = `snapshot:${jobId}`;
    const snap = await env.JOBS.get(snapKey);
    if (!snap) {
      if (faultMode === "stale-snapshot") await env.JOBS.put(snapKey, raw, { expirationTtl: 3600 }).catch(() => {});
      // stale-snapshot-resume records in the resume branch below, post-decision
    } else if (!(await env.JOBS.get(`fault-used:${jobId}`).catch(() => null))) {
      await env.JOBS.put(`fault-used:${jobId}`, "1", { expirationTtl: 3600 }).catch(() => {});
      console.warn(`stale-snapshot-resume: replaying captured generation once job=${jobId}`);
      raw = snap; // replay the older generation once
    }
  }
  if (await env.JOBS.get(`stopped:${jobId}`)) {
    // stopped while a message was in flight: clean up quietly
    let chatId = "";
    try {
      const st = JSON.parse(raw) as JobState;
      chatId = String(st.chatId ?? "");
      if (st.browser) await destroySession(env as any, st.browser);
    } catch { /* best effort */ }
    await env.JOBS.delete(`state:${jobId}`).catch(() => {});
    // the stopped: marker is NEVER deleted here: it must outlive the state
      // (state re-saves carry a fresh TTL, and stale-cached state reads can
      // survive state deletion for ~60s). It expires on its own 25h TTL.
    if (chatId) await env.JOBS.delete(`job:${chatId}`).catch(() => {});
    return;
  }
  let st = JSON.parse(raw) as JobState;
  const jobTg = st.origin === "internal" ? NOOP_TG : tg;
  // Stale-read decision guard (prod incident 2026-10-24, job ...12d899a9): KV edge
  // caches can serve a pre-await snapshot of state: for up to ~60s after the pause
  // was written; a decision delivery reading it would otherwise CONTINUE from that
  // snapshot and silently drop the owner's decision (applyConfirmation no-ops on a
  // non-awaiting state). A decision against a state that could be pre-await means
  // the read is stale: throw (tagged; the queue handler redelivers with a 35s delay,
  // so the 3 retries span ~105s > the ~60s cache window) instead of losing the
  // decision. A consumed round (confirmSeq > 0 / approvedAction set) or a terminal
  // state means a duplicate decision: drop it quietly.
  if ((decision === "approved" || decision === "rejected") && (st.next !== "await_confirm" || !st.pendingConfirm)) {
    if (st.next !== "done" && (st.confirmSeq ?? 0) === 0 && !st.approvedAction) {
      throw new Error("stale-decision-read: redeliver with delay");
    }
    return;
  }
  try {
    // Confirmation resume (queue-serialized first-wins, R3): the decision arrives in
    // THIS message's body. First nonce-matching decision moves the state out of
    // await_confirm; any later decision message finds next !== "await_confirm" and
    // no-ops. A plain continuation message carries no decision: stay paused, no re-enqueue.
    if (st.next === "await_confirm") {
      // A decision message can be queued BEFORE a cancel lands and delivered
      // after it: never apply a decision when a stop signal is visible. The
      // stopped: marker is the primary evidence (24h TTL, never overwritten by
      // any branch); the stopped result record is a fallback. Still best-effort
      // inside the ~60s KV edge-cache window.
      if (await stopSignalVisible(env, jobId)) {
        try { if (st.browser) await destroySession(env as any, st.browser); } catch { /* best effort */ }
        await env.JOBS.delete(`state:${jobId}`).catch(() => {});
        // the stopped: marker is NEVER deleted here: it must outlive the state
      // (state re-saves carry a fresh TTL, and stale-cached state reads can
      // survive state deletion for ~60s). It expires on its own 25h TTL.
        await env.JOBS.delete(`job:${st.chatId}`).catch(() => {});
        return;
      }
      const resumed = applyConfirmation(st, decision ?? null, decisionNonce ?? null);
      if (!resumed) return;
      st = resumed;
      if (env.STAGING_FAULT === "stale-snapshot-resume" && !(await env.JOBS.get(`snapshot:${jobId}`).catch(() => null))) {
        console.warn(`stale-snapshot-resume: capturing post-decision generation job=${jobId}`);
        // Capture the approved generation (unconsumed approvedAction) so a later
        // delivery replays exactly the decisive stale-approval condition.
        await env.JOBS.put(`snapshot:${jobId}`, JSON.stringify(st), { expirationTtl: 3600 }).catch(() => {});
      }
    }
    // Job wall-clock budget at EVERY delivery, not only inside stepLlm: tool-call
    // chains or browser hangs that never land on an llm unit still terminalize
    // (staging run2 class). startedAt persists in KV state across retries,
    // re-enqueues and session recreates - it is never reset.
    if (Date.now() - st.startedAt > JOB_TIMEOUT_MS) {
      st.finalText = "⏳ توقفتُ لأن ميزانية الوقت انتهت قبل إكمال الهدف.";
      st.next = "done";
    }
    for (let i = 0; i < UNITS_PER_INVOCATION && st.next !== "done" && st.next !== "await_confirm"; i++) {
      // per-unit stop check: a /stop landing mid-delivery aborts before the next unit
      if (await env.JOBS.get(`stopped:${jobId}`)) {
        try { if (st.browser) await destroySession(env as any, st.browser); } catch { /* best effort */ }
        await env.JOBS.delete(`state:${jobId}`).catch(() => {});
        // the stopped: marker is NEVER deleted here: it must outlive the state
      // (state re-saves carry a fresh TTL, and stale-cached state reads can
      // survive state deletion for ~60s). It expires on its own 25h TTL.
        await env.JOBS.delete(`job:${st.chatId}`).catch(() => {});
        return;
      }
      if (!st.plan) st = await stepPlan(env as any, st);
      else if (st.next === "llm") st = await stepLlm(env as any, st);
      else if (st.next === "tool") st = await stepTool(env as any, st, jobTg);
      else if (st.next === "nextsub") st = await stepNextSubtask(env as any, st);
      else if (st.next === "synth") st = await stepSynth(env as any, st);
    }
  } catch (e) {
    st.finalText = `❌ تعذّر إكمال المهمة: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
    st.next = "done";
  }
  if (st.next === "await_confirm") {
    // Durable-stop guard (run7 defect): a cancel landing mid-delivery can be
    // missed by the per-unit check inside the ~60s KV edge-cache window; without
    // this check the pause below OVERWRITES the stopped result with
    // awaiting_confirmation and re-arms a cancelled job for owner approval.
    if (await stopSignalVisible(env, jobId)) {
      try { if (st.browser) await destroySession(env as any, st.browser); } catch { /* best effort */ }
      await env.JOBS.delete(`state:${jobId}`).catch(() => {});
      // the stopped: marker is NEVER deleted here: it must outlive the state
      // (state re-saves carry a fresh TTL, and stale-cached state reads can
      // survive state deletion for ~60s). It expires on its own 25h TTL.
      await env.JOBS.delete(`job:${st.chatId}`).catch(() => {});
      return; // the stopped result record written by /task-cancel (or /stop) stands
    }
    // Paused for owner approval: save and stop; /task-confirm re-enqueues.
    // TTL matches the 24h awaiting marker so the job stays resumable as long as
    // /task-result reports awaiting_confirmation (H4).
    await env.JOBS.put(`state:${jobId}`, JSON.stringify(st), { expirationTtl: 86400 });
    // Fresh-key awaiting record (prod incident 2026-10-24): state: is edge-cached at
    // any PoP that read it during the run, so /task-confirm could read a pre-await
    // snapshot for up to ~60s after this write and refuse a fast owner reply with a
    // false "not awaiting" 409. confirm:${jobId} is a brand-new key per task - never
    // read anywhere before - so its first read at any PoP is a cold central read (KV
    // docs: initial reads have no cached value) and always fresh. TTL mirrors state:
    // so a task dying between write and delete cannot leak the key (review checkpoint).
    await env.JOBS.put(`confirm:${jobId}`, JSON.stringify({ nonce: st.pendingConfirm?.nonce ?? "", at: Date.now() }), { expirationTtl: 86400 });
    if (st.origin === "internal") {
      await env.JOBS.put(`result:${jobId}`, JSON.stringify({
        // nonce included (review F1a): the pull fallback must be able to answer the
        // confirmation, not only the callback path.
        status: "awaiting_confirmation", confirm: st.pendingConfirm?.summary ?? "", nonce: st.pendingConfirm?.nonce ?? "", at: Date.now(),
      }), { expirationTtl: 86400 });
      await notifyVal(env, st, { status: "awaiting_confirmation", confirm: st.pendingConfirm?.summary ?? "", nonce: st.pendingConfirm?.nonce ?? "" });
    }
    return;
  }
  if (st.next !== "done") {
    await env.JOBS.put(`state:${jobId}`, JSON.stringify(st), { expirationTtl: 3600 });
    await env.JOBS_QUEUE.send({ jobId });
    return;
  }
  // final-send guard: a stop that landed during the last unit still suppresses delivery.
  // NOTE: KV reads are edge-cached up to ~60s, so this is best-effort, not a hard cancel.
  if (await env.JOBS.get(`stopped:${jobId}`)) {
    try { if (st.browser) await destroySession(env as any, st.browser); } catch { /* best effort */ }
    await env.JOBS.delete(`state:${jobId}`).catch(() => {});
    // the stopped: marker is NEVER deleted here: it must outlive the state
      // (state re-saves carry a fresh TTL, and stale-cached state reads can
      // survive state deletion for ~60s). It expires on its own 25h TTL.
    await env.JOBS.delete(`job:${st.chatId}`).catch(() => {});
    return;
  }
  // deliver
  if (env.STAGING_FAULT === "deliver-fail-once" && st.origin === "internal" && !(await env.JOBS.get(`fault-used:${jobId}`).catch(() => null))) {
    await env.JOBS.put(`fault-used:${jobId}`, "1", { expirationTtl: 3600 }).catch(() => {});
    throw new Error("STAGING_FAULT deliver-fail-once: injected terminal-deliver failure (test hook)");
  }
  if (st.origin === "internal") {
    const okI = !st.finalText.startsWith("❌") && !st.finalText.startsWith("🛑") && !st.finalText.startsWith("⚠️");
    await env.JOBS.put(`result:${jobId}`, JSON.stringify({
      status: okI ? "done" : "failed", text: st.finalText, ms: Date.now() - st.startedAt, at: Date.now(),
    }), { expirationTtl: 86400 });
    if (st.browser) await destroySession(env as any, st.browser).catch(() => {});
    await env.JOBS.delete(`state:${jobId}`).catch(() => {});
    await notifyVal(env, st, { status: okI ? "done" : "failed", text: st.finalText });
    return;
  }
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


// A stop signal visible to this read: the fresh stopped: marker OR the
// lifecycle-matched (24h) stopped result record. Both are KV reads subject to
// the ~60s edge-cache window - best-effort, never a hard cancel guarantee.
async function stopSignalVisible(env: Env, id: string): Promise<boolean> {
  if (await env.JOBS.get(`stopped:${id}`)) return true;
  try {
    const r = JSON.parse((await env.JOBS.get(`result:${id}`)) ?? "null") as { status?: string } | null;
    return r?.status === "stopped";
  } catch { return false; }
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
    // Internal task API (main-bot <-> worker integration, spec Phase 2). Gated by a
    // shared secret in the x-internal-key header (or ?key= for GET); no Telegram sends.
    if (request.method === "POST" && url.pathname === "/task") {
      if (!env.INTERNAL_TASK_SECRET || request.headers.get("x-internal-key") !== env.INTERNAL_TASK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let body: any;
      try { body = await request.json(); } catch { return new Response("bad body", { status: 400 }); }
      const task = String(body?.task ?? "").trim();
      if (!task || task.length > 4000) return Response.json({ error: "task required (<=4000 chars)" }, { status: 400 });
      const jobId = `task-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const cbChat = Number(body?.callback_chat_id);
      const st = initJobState(0, task, "", 0, { origin: "internal", perms: "interact", jobId, ...(Number.isFinite(cbChat) && cbChat > 0 ? { callbackChatId: cbChat } : {}) });
      try {
        await env.JOBS.put(`state:${jobId}`, JSON.stringify(st), { expirationTtl: 3600 });
        const check = await env.JOBS.get(`state:${jobId}`);
        if (!check) throw new Error("state read-back empty");
        await env.JOBS_QUEUE.send({ jobId });
      } catch (e) {
        return Response.json({ error: `failed to start task: ${(e instanceof Error ? e.message : String(e)).slice(0, 150)}` }, { status: 502 });
      }
      return Response.json({ job_id: jobId, status: "running" });
    }
    if (request.method === "GET" && url.pathname === "/task-artifact") {
      // Post-execution proof jpeg for owner-approved actions (staging review).
      // Same header-only auth as /task-result; controlled-fixture scope only.
      if (!env.INTERNAL_TASK_SECRET || request.headers.get("x-internal-key") !== env.INTERNAL_TASK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const id = url.searchParams.get("id") ?? "";
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const b64 = await env.JOBS.get(`artifact:${id}`);
      if (!b64) return new Response("not found", { status: 404 });
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return new Response(bin, { headers: { "content-type": "image/jpeg", "cache-control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/task-result") {
      // Header auth only: secrets in URLs end up in logs (review finding).
      if (!env.INTERNAL_TASK_SECRET || request.headers.get("x-internal-key") !== env.INTERNAL_TASK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const id = url.searchParams.get("id") ?? "";
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const done = await env.JOBS.get(`result:${id}`);
      if (done) return new Response(done, { headers: { "content-type": "application/json; charset=utf-8" } });
      const raw = await env.JOBS.get(`state:${id}`);
      if (raw) {
        try {
          const st = JSON.parse(raw) as JobState;
          if (st.next === "await_confirm") {
            return Response.json({ status: "awaiting_confirmation", confirm: st.pendingConfirm?.summary ?? "", nonce: st.pendingConfirm?.nonce ?? "" });
          }
          return Response.json({ status: "running" });
        } catch { /* fall through to unknown */ }
      }
      return Response.json({ status: "unknown" });
    }
    if (request.method === "POST" && url.pathname === "/task-cancel") {
      if (!env.INTERNAL_TASK_SECRET || request.headers.get("x-internal-key") !== env.INTERNAL_TASK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let body: any;
      try { body = await request.json(); } catch { return new Response("bad body", { status: 400 }); }
      const id = String(body?.id ?? "");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const raw = await env.JOBS.get(`state:${id}`);
      if (!raw) {
        const done = await env.JOBS.get(`result:${id}`);
        return Response.json({ error: done ? "task already finished" : "unknown or expired task" }, { status: 404 });
      }
      // Same semantics as Telegram /stop: acknowledged at the next unit boundary,
      // best-effort browser cleanup, not a hard mid-action cancel.
      // Marker lifetime must EXCEED any possible state resurrection: a 1h
      // marker expired under a still-paused cancelled job (the >1h rearm
      // hole), and equal 24h TTLs are not proof either - a post-cancel
      // delivery can re-save state with a fresh 24h TTL minutes later.
      // 25h: outlives the 24h paused-state lifecycle plus the bounded window
      // (~60s edge cache) in which a post-cancel delivery can still re-save
      // state with a fresh 24h TTL before any guard sees this marker.
      await env.JOBS.put(`stopped:${id}`, "1", { expirationTtl: 90000 });
      try { const st = JSON.parse(raw) as JobState; if (st.browser) await destroySession(env as any, st.browser); } catch { /* in flight */ }
      // Owner callback for the cancel (found gap: previously the owner/val only
      // learned of a cancel by polling /task-result). The val maps "stopped" -> 🛑.
      // Known residual (disclosed, not fixed here): within the ~60s KV edge-cache
      // window an in-flight delivery can miss the stopped: marker and still
      // terminalize -> a second, later done/failed callback for the same job
      // (different event_id, so val dedupe does NOT suppress it). Cancel remains
      // best-effort, never a hard mid-action abort.
      try {
        const st = JSON.parse(raw) as JobState;
        if (st.origin === "internal" && st.callbackChatId) await notifyVal(env, st, { status: "stopped", text: "أُلغيت المهمة بطلب المالك." });
      } catch { /* callback is best effort; the stopped result record stands */ }
      await env.JOBS.delete(`confirm:${id}`).catch(() => {}); // a stale decision must not resume a cancelled task
      await env.JOBS.delete(`result:${id}`).catch(() => {});
      await env.JOBS.put(`result:${id}`, JSON.stringify({ status: "stopped", text: "أُلغيت المهمة بطلب المالك.", at: Date.now() }), { expirationTtl: 86400 });
      return Response.json({ ok: true, status: "stopped" });
    }
    if (request.method === "POST" && url.pathname === "/task-confirm") {
      if (!env.INTERNAL_TASK_SECRET || request.headers.get("x-internal-key") !== env.INTERNAL_TASK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      let body: any;
      try { body = await request.json(); } catch { return new Response("bad body", { status: 400 }); }
      const id = String(body?.id ?? "");
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const raw = await env.JOBS.get(`state:${id}`);
      if (!raw) return Response.json({ error: "unknown or expired task (state TTL 1h); the task cannot be resumed - cancel and re-issue" }, { status: 404 });
      let st: JobState;
      try { st = JSON.parse(raw) as JobState; } catch { return Response.json({ error: "corrupt state" }, { status: 500 }); }
      if (await stopSignalVisible(env, id)) return Response.json({ error: "task was cancelled; confirmation refused" }, { status: 409 });
      if (st.next !== "await_confirm" || !st.pendingConfirm) {
        // KV reads are edge-cached up to ~60s: a fast owner reply can land while this
        // PoP still serves the pre-await snapshot of state: (the await-state write
        // PRECEDES the callback - prod incident 2026-10-24). Fall back to the fresh
        // awaiting record. Boundary (review 2026-10-24): only a read state that could
        // be a pre-await snapshot falls back - a consumed round (confirmSeq > 0 or
        // approvedAction set) or a terminal state refuses immediately.
        const couldBePreAwait = st.next !== "done" && (st.confirmSeq ?? 0) === 0 && !st.approvedAction;
        const rec = couldBePreAwait ? await env.JOBS.get(`confirm:${id}`) : null;
        if (!rec) return Response.json({ error: "task is not awaiting confirmation" }, { status: 409 });
        try {
          // The nonce check below runs against THIS fresh record, so the fallback
          // can never bypass the per-round nonce binding (review checkpoint 1).
          st.pendingConfirm = { nonce: String((JSON.parse(rec) as any).nonce ?? "") } as JobState["pendingConfirm"];
        } catch {
          return Response.json({ error: "corrupt confirm record" }, { status: 500 });
        }
      }
      // Bind the decision to THIS confirmation round (review B2): the nonce is
      // disclosed only via the awaiting_confirmation callback/read for this pause.
      const nonce = String(body?.nonce ?? "");
      if (!nonce || nonce !== st.pendingConfirm!.nonce) {
        return Response.json({ error: "nonce mismatch: this answers a stale or foreign confirmation round" }, { status: 409 });
      }
      // Decisions are applied by the job's own queue chain, which is already serialized
      // (max_batch_size=1, max_concurrency=1): the first nonce-matching decision message
      // moves the state out of await_confirm; any later decision message no-ops. The
      // decision travels IN the message body - no KV decision record that can expire or
      // orphan the job if the send fails (queue send failure here returns 502 and the
      // job stays paused, retriable by the owner).
      const decision = body?.approve === true ? "approved" : "rejected";
      try {
        await env.JOBS_QUEUE.send({ jobId: id, decision, nonce });
      } catch (e) {
        return Response.json({ error: `failed to queue decision: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` }, { status: 502 });
      }
      await env.JOBS.delete(`result:${id}`).catch(() => {}); // clear the awaiting marker
      // Consume the fresh awaiting record. A duplicate confirm inside the delete's
      // propagation window can re-queue at most one more decision; the consumer's
      // nonce + consumed-round guards drop it (see runUnits).
      await env.JOBS.delete(`confirm:${id}`).catch(() => {});
      return Response.json({ ok: true, decision, applied: "queued" });
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
        await env.JOBS.put(`stopped:${jobId}`, "1", { expirationTtl: 90000 }); // 25h: 24h state lifecycle + re-save window margin
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
      const st = initJobState(chatId, text, historyText(history), statusMsgId, { origin: "telegram", perms: "read", jobId });
      try {
        await env.JOBS.put(`state:${jobId}`, JSON.stringify(st), { expirationTtl: 3600 });
        await env.JOBS.put(`job:${chatId}`, jobId, { expirationTtl: 3600 });
        // read-back: a missing state write would strand the job silently
        const check = await env.JOBS.get(`state:${jobId}`);
        if (!check) throw new Error("state read-back empty");
        await env.JOBS_QUEUE.send({ jobId });
      } catch (e) {
        await env.JOBS.delete(`job:${chatId}`).catch(() => {});
        await tg.sendMessage(chatId, `❌ تعذّر بدء المهمة (تخزين الحالة): ${(e instanceof Error ? e.message : String(e)).slice(0, 150)}`).catch(() => {});
      }
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  },

  async queue(batch: MessageBatch, env: Env): Promise<void> {
    // Dead-letter queue: surface exhausted jobs to the user instead of stranding them.
    if (batch.queue.endsWith("-dlq")) {
      for (const message of batch.messages) {
        try {
          const { jobId } = message.body as { jobId: string };
          const tg = createTelegram(env.TELEGRAM_BOT_TOKEN);
          let chatId = Number(env.ADMIN_TELEGRAM_ID.split(",")[0].trim());
          let goal = "";
          let origin = "telegram";
          let cbChatId = 0;
          const raw = await env.JOBS.get(`state:${jobId}`);
          if (raw) {
            try {
              const st = JSON.parse(raw) as JobState;
              chatId = st.chatId ?? chatId;
              goal = st.goal ?? "";
              origin = st.origin ?? "telegram";
              cbChatId = st.callbackChatId ?? 0;
              if (st.browser) await destroySession(env as any, st.browser).catch(() => {});
            } catch { /* best effort */ }
          }
          const note = `❌ توقفت المهمة: نفدت محاولات التسليم الداخلي لخطواتها (عطل نقل داخلي، لم تُحذف بياناتك). أعد إرسال الطلب كما هو للمحاولة مجدداً: ${goal.slice(0, 150)}`;
          if (origin === "internal") {
            await env.JOBS.put(`result:${jobId}`, JSON.stringify({ status: "failed", text: note, ms: 0, at: Date.now() }), { expirationTtl: 86400 }).catch(() => {});
            if (cbChatId) await notifyVal(env, { jobId, callbackChatId: cbChatId } as JobState, { status: "failed", text: note });
          } else {
            await tg.sendMessage(chatId, note).catch(() => {});
            await env.JOBS.put(`last:${chatId}`, JSON.stringify({ ok: false, text: note, ms: 0, lines: [], at: Date.now() })).catch(() => {});
          }
          await env.JOBS.delete(`state:${jobId}`).catch(() => {});
          // the stopped: marker is NEVER deleted here: it must outlive the state
      // (state re-saves carry a fresh TTL, and stale-cached state reads can
      // survive state deletion for ~60s). It expires on its own 25h TTL.
          await env.JOBS.delete(`job:${chatId}`).catch(() => {});
          message.ack();
        } catch (e) { console.error("dlq handling failed:", e); message.retry(); }
      }
      return;
    }
    for (const message of batch.messages) {
      try {
        const { jobId, decision, nonce } = message.body as { jobId: string; decision?: string; nonce?: string };
        await runUnits(env, jobId, decision, nonce);
        message.ack();
      } catch (e) {
        console.error("queue unit failed:", e);
        // A stale decision read must outlive the ~60s KV edge-cache window: 3 retries
        // at 35s span ~105s (review condition 2026-10-24). Other failures keep the
        // platform default backoff.
        if (e instanceof Error && e.message.startsWith("stale-decision-read")) message.retry({ delaySeconds: 35 });
        else message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;

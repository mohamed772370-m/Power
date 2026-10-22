// Telegram conversation logic: owner-only, one job per chat, throttled live status, /stop, short follow-up memory.
import type { Telegram } from "./telegram.ts";
import type { SolveCtx, SolveResult } from "./solve.ts";

export const HELP_TEXT =
  "👋 أنا وكيل تصفح. أرسل لي أي مهمة على الإنترنت بنص عادي وسأنفذها وأعيد لك النتيجة.\n\n" +
  "أمثلة:\n• قارن أسعار هذا المنتج في 3 مواقع: …\n• افتح الرابط … واستخرج الجدول\n• ادخل الموقع … واملأ النموذج بهذه البيانات\n\n" +
  "إن كانت المهمة تتكون من أجزاء مستقلة قسّمتها ونفّذتها بالتوازي لأسرع.\n/stop إيقاف المهمة الجارية\n/help هذه الرسالة";

export interface BotDeps {
  tg: Telegram;
  solve: (goal: string, ctx: SolveCtx) => Promise<SolveResult>;
  allowed: Set<number>;
  statusThrottleMs?: number;
  jobTimeoutMs?: number;
}
interface Job { abort: AbortController; startedAt: number; promise: Promise<void> }

export function createBot(deps: BotDeps) {
  const { tg } = deps;
  const throttle = deps.statusThrottleMs ?? 1500;
  const jobs = new Map<number, Job>();
  const history = new Map<number, Array<{ goal: string; answer: string }>>();
  const warned = new Set<number>();

  function historyText(chatId: number): string {
    const h = history.get(chatId) ?? [];
    return h.length ? "سياق المحادثة السابقة (للمتابعة فقط):\n" + h.map((x) => `- الطلب: ${x.goal.slice(0, 300)}\n  النتيجة: ${x.answer.slice(0, 700)}`).join("\n") : "";
  }

  async function runJob(chatId: number, goal: string, abort: AbortController): Promise<void> {
    const t0 = Date.now();
    const statusId = await tg.sendMessage(chatId, "⏳ بدأتُ العمل على المهمة…").catch(() => 0);
    const lines: string[] = []; let lastEdit = 0; let timer: ReturnType<typeof setTimeout> | null = null; let closed = false;
    const flush = async () => {
      timer = null; if (closed || !statusId || !lines.length) return; lastEdit = Date.now();
      await tg.editMessage(chatId, statusId, "⏳ جارٍ التنفيذ…\n" + lines.slice(-8).join("\n")).catch(() => {});
    };
    const onStatus = (t: string) => {
      lines.push(t.slice(0, 160));
      if (timer || closed) return;
      const wait = Math.max(0, throttle - (Date.now() - lastEdit));
      timer = setTimeout(flush, wait);
    };
    const typingTimer = setInterval(() => { void tg.typing(chatId); }, 4500); void tg.typing(chatId);
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(deps.jobTimeoutMs ?? 20 * 60_000)]);
    let answer = ""; let ok = true;
    try {
      const r = await deps.solve(goal, { chatId, onStatus, signal, history: historyText(chatId) });
      answer = r.text;
    } catch (e) {
      ok = false; answer = `❌ تعذّر إكمال المهمة: ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`;
    } finally {
      closed = true; clearInterval(typingTimer); if (timer) clearTimeout(timer);
    }
    const secs = Math.round((Date.now() - t0) / 1000);
    const stopped = abort.signal.aborted;
    if (statusId) await tg.editMessage(chatId, statusId, `${stopped ? "⛔ أُوقفت" : ok ? "✅ انتهت" : "❌ فشلت"} المهمة (${secs}ث)`).catch(() => {});
    await tg.sendMessage(chatId, answer).catch(() => {});
    if (ok && !stopped) { const h = history.get(chatId) ?? []; h.push({ goal, answer }); history.set(chatId, h.slice(-3)); }
    jobs.delete(chatId);
  }

  async function handleUpdate(update: any): Promise<void> {
    const msg = update?.message; if (!msg) return;
    const chatId: number = msg.chat?.id; const from: number = msg.from?.id;
    if (!chatId || !from) return;
    if (!deps.allowed.has(from)) {
      if (!warned.has(from)) { warned.add(from); await tg.sendMessage(chatId, "⛔ هذا البوت خاص.").catch(() => {}); }
      return;
    }
    const text = String(msg.text ?? "").trim();
    if (!text) { await tg.sendMessage(chatId, "أرسل المهمة كنص من فضلك.").catch(() => {}); return; }
    const cmd = text.split(/[\s@]/)[0].toLowerCase();
    if (cmd === "/start" || cmd === "/help") { await tg.sendMessage(chatId, HELP_TEXT); return; }
    if (cmd === "/stop") {
      const j = jobs.get(chatId);
      if (!j) { await tg.sendMessage(chatId, "لا توجد مهمة جارية."); return; }
      j.abort.abort(); await tg.sendMessage(chatId, "⛔ جارٍ إيقاف المهمة…"); return;
    }
    if (text.startsWith("/")) { await tg.sendMessage(chatId, "أمر غير معروف. أرسل /help"); return; }
    if (jobs.has(chatId)) { await tg.sendMessage(chatId, "⏳ عندي مهمة جارية. انتظرها أو أرسل /stop لإيقافها."); return; }
    const abort = new AbortController();
    const promise = runJob(chatId, text, abort);
    jobs.set(chatId, { abort, startedAt: Date.now(), promise });
  }

  return {
    handleUpdate, jobs,
    async stopAll(): Promise<void> { for (const j of jobs.values()) j.abort.abort(); await Promise.allSettled([...jobs.values()].map((j) => j.promise)); },
  };
}

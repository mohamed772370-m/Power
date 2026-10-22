// Task solver: optionally splits a goal into independent subtasks, runs them as parallel browser sub-agents
// (each with its own cloud browser session), then merges the results. Single tasks go straight to one sub-agent.
import { runBrowseTask } from "./browseagent.ts";
import type { Msg } from "./llm.ts";

export interface Subtask { goal: string }
export interface Plan { mode: "single" | "parallel"; subtasks: Subtask[] }

export const PLAN_PROMPT =
  "أنت مخطِّط مهام تصفح. قرّر هل يُنفَّذ الطلب كمهمة واحدة أم يُقسَّم إلى مهام فرعية متوازية لتسريعه.\n" +
  "قسّم (parallel) فقط إذا كانت هناك مهمتان فرعيتان أو أكثر مستقلتان تماماً: لا تحتاج إحداها نتيجة الأخرى، ويمكن تنفيذ كل منها في متصفح منفصل دون حالة مشتركة (مثل تسجيل دخول واحد أو جلسة واحدة).\n" +
  "إن كانت الخطوات متسلسلة أو تعتمد على جلسة واحدة (نموذج متعدد الصفحات، اختبار/استبيان متتابع، تسجيل دخول ثم عمل) فاجعلها single.\n" +
  "كل مهمة فرعية يجب أن تكون مكتفية بذاتها: تتضمن الروابط والبيانات اللازمة من الطلب الأصلي، وتصف بالضبط ما يُرجَع منها.\n" +
  'أجب بـ JSON فقط بلا أي نص آخر: {"mode":"single"|"parallel","subtasks":[{"goal":"..."}]}';

export const SYNTH_PROMPT =
  "اجمع نتائج المهام الفرعية في إجابة نهائية واحدة دقيقة ومرتبة تجيب على الطلب الأصلي، بنفس لغة المستخدم.\n" +
  "اعتمد فقط على ما ورد في النتائج ولا تضف معلومات من عندك. اذكر الروابط المصدر. إن فشلت مهمة فرعية أو كانت جزئية فاذكر ذلك صراحةً.";

export function shouldPlan(goal: string): boolean { return goal.trim().length >= 70; }

export function parsePlan(raw: string, goal: string, maxSubtasks: number): Plan {
  const single: Plan = { mode: "single", subtasks: [{ goal }] };
  const m = String(raw ?? "").match(/\{[\s\S]*\}/);
  if (!m) return single;
  try {
    const o = JSON.parse(m[0]);
    if (o?.mode !== "parallel" || !Array.isArray(o.subtasks)) return single;
    const subs: Subtask[] = o.subtasks
      .map((s: { goal?: unknown }) => ({ goal: String(s?.goal ?? "").trim() }))
      .filter((s: Subtask) => s.goal.length > 0)
      .slice(0, maxSubtasks);
    return subs.length >= 2 ? { mode: "parallel", subtasks: subs } : single;
  } catch { return single; }
}

export class Semaphore {
  private free: number;
  private waiters: Array<() => void> = [];
  constructor(n: number) { this.free = Math.max(1, n); }
  async acquire(): Promise<() => void> {
    if (this.free > 0) this.free--; else await new Promise<void>((r) => this.waiters.push(r));
    let released = false;
    return () => { if (released) return; released = true; const w = this.waiters.shift(); if (w) w(); else this.free++; };
  }
}

export interface BrowserHandle { browserAction: (chatId: number, act: string, target: string, val: string) => Promise<string>; resetBrowser: () => Promise<void> }
export interface SolveDeps {
  chat: (messages: Msg[], tools?: unknown, temperature?: number) => Promise<Msg>;
  makeBrowser: () => BrowserHandle;
  readUrl: (url: string) => Promise<string>;
  webSearch: (q: string) => Promise<string>;
  sem: Semaphore;
  maxSubtasks?: number;
}
export interface SolveCtx { chatId: number; onStatus?: (t: string) => void | Promise<void>; signal?: AbortSignal; history?: string; budgetMs?: number }
export interface SolveResult { text: string; plan: Plan; results: string[]; ms: number }

export async function planTask(fullGoal: string, deps: SolveDeps): Promise<Plan> {
  const max = deps.maxSubtasks ?? 5;
  try {
    const r = await deps.chat([{ role: "system", content: PLAN_PROMPT }, { role: "user", content: `الطلب:\n${fullGoal}\n\nالحد الأقصى للمهام الفرعية: ${max}` }], undefined, 0);
    return parsePlan(String(r?.content ?? ""), fullGoal, max);
  } catch { return { mode: "single", subtasks: [{ goal: fullGoal }] }; }
}

export async function solveTask(goal: string, deps: SolveDeps, ctx: SolveCtx): Promise<SolveResult> {
  const t0 = Date.now();
  const fullGoal = ctx.history ? `${ctx.history}\n\nالطلب الحالي: ${goal}` : goal;
  const plan: Plan = shouldPlan(goal) ? await planTask(fullGoal, deps) : { mode: "single", subtasks: [{ goal: fullGoal }] };
  const n = plan.subtasks.length; const multi = n > 1;
  if (multi) await ctx.onStatus?.(`🧩 قسّمتُ المهمة إلى ${n} مهام متوازية`);

  const results = await Promise.all(plan.subtasks.map(async (st, i): Promise<string> => {
    const release = await deps.sem.acquire();
    const b = deps.makeBrowser();
    try {
      if (ctx.signal?.aborted) return "⛔ أُوقفت المهمة.";
      return await runBrowseTask(st.goal, ctx.chatId, {
        callModel: (m, t) => deps.chat(m, t),
        browserAction: b.browserAction, readUrl: deps.readUrl, webSearch: deps.webSearch,
        onStatus: (t) => ctx.onStatus?.(multi ? `[${i + 1}/${n}] ${t}` : t),
      }, { signal: ctx.signal, budgetMs: ctx.budgetMs });
    } catch (e) {
      return `❌ خطأ غير متوقع: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`;
    } finally {
      release();
      await b.resetBrowser().catch(() => {}); // always free the cloud browser session
    }
  }));

  if (!multi) return { text: results[0], plan, results, ms: Date.now() - t0 };
  await ctx.onStatus?.("🧮 أجمع النتائج…");
  let text: string;
  try {
    const body = results.map((r, i) => `--- مهمة ${i + 1}: ${plan.subtasks[i].goal}\n${r}`).join("\n\n");
    const r = await deps.chat([{ role: "system", content: SYNTH_PROMPT }, { role: "user", content: `الطلب الأصلي:\n${fullGoal}\n\nنتائج المهام الفرعية:\n${body}` }], undefined, 0.1);
    text = String(r?.content ?? "").trim() || results.join("\n\n");
  } catch { text = results.map((r, i) => `(${i + 1}) ${r}`).join("\n\n"); }
  return { text, plan, results, ms: Date.now() - t0 };
}

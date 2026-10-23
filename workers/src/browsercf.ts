// Cloud browser controller for Workers: Kernel (primary) / Steel (backup) cloud
// sessions driven over CDP WebSocket. Sessions live in the cloud across workflow
// steps; each action opens a fresh WebSocket to the stored session and leaves
// the session running for the next step. No cookies are persisted (clean
// browser per task, same as the Render version).
import { Cdp, CdpPage, sleep } from "./cdp.ts";
import { somJs } from "./som.ts";
import { BROWSER_UA } from "./websearch.ts";

export interface BrowserSessionInfo {
  provider: "kernel" | "steel";
  sessionId: string;
  cdpWsUrl: string;
  targets: string[]; // tab stack; last = current tab
}

export interface BrowserEnv {
  KERNEL_API_KEY?: string;
  STEEL_API_KEY?: string;
}

export interface BrowserCbs {
  sendPhoto: (chatId: number, b64Jpeg: string, caption: string) => Promise<void>;
  analyzeImage: (b64Jpeg: string, prompt: string) => Promise<string>;
}

export async function createSession(env: BrowserEnv): Promise<Omit<BrowserSessionInfo, "targets">> {
  const kernelKey = (env.KERNEL_API_KEY ?? "").trim();
  const steelKey = (env.STEEL_API_KEY ?? "").trim();
  if (kernelKey) {
    try {
      const res = await fetch("https://api.onkernel.com/browsers", {
        method: "POST",
        headers: { Authorization: `Bearer ${kernelKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ headless: true }),
      });
      const body: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Kernel create failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
      const sessionId = body.session_id ?? body.id ?? body.sessionId;
      const cdpWsUrl = body.cdp_ws_url ?? body.cdpWsUrl;
      if (!sessionId || !cdpWsUrl) throw new Error("Kernel returned an unexpected session shape");
      return { provider: "kernel", sessionId: String(sessionId), cdpWsUrl: String(cdpWsUrl) };
    } catch (e) {
      if (!steelKey) throw e;
    }
  }
  if (!steelKey) throw new Error("لا KERNEL_API_KEY ولا STEEL_API_KEY مضبوط");
  const res = await fetch("https://api.steel.dev/v1/sessions", {
    method: "POST", headers: { "steel-api-key": steelKey, "Content-Type": "application/json" }, body: JSON.stringify({}),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Steel create failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  const sessionId = body.id ?? body.session_id ?? body.sessionId;
  if (!sessionId) throw new Error("Steel returned an unexpected session shape");
  return {
    provider: "steel", sessionId: String(sessionId),
    cdpWsUrl: `wss://connect.steel.dev?apiKey=${encodeURIComponent(steelKey)}&sessionId=${encodeURIComponent(String(sessionId))}`,
  };
}

export async function destroySession(env: BrowserEnv, sess: Pick<BrowserSessionInfo, "provider" | "sessionId">): Promise<void> {
  try {
    if (sess.provider === "steel") {
      await fetch(`https://api.steel.dev/v1/sessions/${sess.sessionId}/release`, {
        method: "POST", headers: { "steel-api-key": (env.STEEL_API_KEY ?? "").trim() },
      });
    } else {
      await fetch(`https://api.onkernel.com/browsers/${sess.sessionId}`, {
        method: "DELETE", headers: { Authorization: `Bearer ${(env.KERNEL_API_KEY ?? "").trim()}` },
      });
    }
  } catch { /* cleanup must not mask the real error */ }
}

class ElementNotFound extends Error {}

const SOM_EXPR = "(" + somJs.toString() + ")()";

interface Ctx {
  cdp: Cdp;
  page: CdpPage;
  pages: Map<string, CdpPage>; // targetId -> attached page
}

async function connectCtx(sess: BrowserSessionInfo): Promise<Ctx> {
  const cdp = await Cdp.connect(sess.cdpWsUrl);
  const pages = new Map<string, CdpPage>();
  const attach = async (targetId: string): Promise<CdpPage> => {
    const sessionId = await cdp.attach(targetId);
    const p = new CdpPage(cdp, targetId, sessionId);
    await p.init(BROWSER_UA);
    pages.set(targetId, p);
    return p;
  };
  let page: CdpPage | null = null;
  if (sess.targets.length) {
    const existing = new Set((await cdp.listTargets()).filter((t) => t.type === "page").map((t) => t.targetId));
    // drop dead tabs from the stack
    while (sess.targets.length && !existing.has(sess.targets[sess.targets.length - 1])) sess.targets.pop();
    if (sess.targets.length) page = await attach(sess.targets[sess.targets.length - 1]);
  }
  if (!page) {
    const targetId = await cdp.createTarget("about:blank");
    sess.targets = [targetId];
    page = await attach(targetId);
  }
  return { cdp, page, pages };
}

// Bounded settle: give a potential navigation / render a capped chance, then move on.
async function settle(page: CdpPage, maxMs: number): Promise<void> {
  await page.waitLoadEvent(Math.min(maxMs, 1500)).catch(() => {});
  await sleep(Math.min(600, Math.max(150, maxMs / 4)));
}

async function markAndCapture(page: CdpPage, opts: { shot?: boolean } = {}): Promise<{ report: string; screenshotB64: string }> {
  let som: any = { items: [], blocked: 0, overlayText: "", scrollY: 0, docH: 0, vh: 0 };
  let pageText = "";
  const scan = async () => {
    try {
      const r = await page.evaluate(SOM_EXPR);
      som = Array.isArray(r) ? { ...som, items: r } : { ...som, ...(r ?? {}) };
    } catch { som = { ...som, items: [] }; }
    try { pageText = String(await page.evaluate("document.body.innerText.slice(0, 3500)") ?? ""); } catch { pageText = ""; }
  };
  await scan();
  if ((som.items?.length ?? 0) === 0 && pageText.length < 80) { await settle(page, 2000); await scan(); }
  const screenshotB64 = opts.shot ? await page.screenshotJpeg(55).catch(() => "") : "";
  const lines = ((som.items ?? []) as Array<Record<string, unknown>>).slice(0, 100).map((it) => {
    let l = `[${it.id}]${it.pos ? " " + it.pos : ""} <${it.tag} ${it.type}>: ${it.text}`;
    if (it.href) l += ` → ${it.href}`;
    if (it.val) l += ` (قيمة: ${it.val})`;
    if (it.checked !== undefined) l += it.checked ? " ☑" : " ☐";
    if (it.disabled) l += " (معطّل)";
    return l;
  });
  const title = await page.title().catch(() => "");
  const url = await page.url().catch(() => "");
  const more = som.docH && som.vh && som.scrollY + som.vh < som.docH - 20;
  const scrollLine = som.docH ? `موضع التمرير: ${som.scrollY}/${Math.max(0, som.docH - som.vh)}px${more ? " (يوجد المزيد أسفل الصفحة)" : " (نهاية الصفحة)"}\n` : "";
  const overlayLine = som.blocked
    ? `⚠️ تراكب/نافذة تغطي الصفحة ("${som.overlayText}") وتحجب ${som.blocked} عنصراً، فالعناصر المحجوبة غير مدرجة. تعامل مع النافذة أولاً (قبول/إغلاق) ثم تابع.\n`
    : "";
  const report =
    `الرابط الحالي: ${url}\n` +
    `عنوان الصفحة: ${title}\n` +
    scrollLine + overlayLine + `\n` +
    `--- النص الظاهر في الصفحة ---\n${pageText}\n\n` +
    `--- العناصر التفاعلية المرقمة (استخدم الرقم فقط في target عند النقر أو الكتابة؛ ↓/↑ = خارج الشاشة) ---\n${lines.join("\n")}`;
  return { report, screenshotB64 };
}

const cleanId = (target: string) => String(target).replace(/^[\[\]\s]+|[\[\]\s]+$/g, "");

const FIND_EL_EXPR = (id: string) => `(() => {
  const e = document.querySelector('[data-ai-id="${id.replace(/"/g, "")}"]');
  if (!e) return null;
  e.scrollIntoView({ block: "center" });
  const r = e.getBoundingClientRect();
  const a = e.closest ? e.closest("a") : null;
  const opens = (a && a.target === "_blank") || /window\\.open/.test(e.getAttribute("onclick") || "");
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, opens };
})()`;

async function actOnce(env: BrowserEnv, sess: BrowserSessionInfo, chatId: number, act: string, target: string, val: string, cbs: BrowserCbs): Promise<string> {
  const ctx = await connectCtx(sess);
  try {
    let page = ctx.page;
    let note = "";
    // track pages created while we are connected (popups / target=_blank)
    let popupId = "";
    ctx.cdp.on("Target.targetCreated", (p: any) => { if (p?.targetInfo?.type === "page") popupId = String(p.targetInfo.targetId); });
    await ctx.cdp.send("Target.setDiscoverTargets", { discover: true }).catch(() => {});

    const findEl = async (): Promise<{ x: number; y: number; opens: boolean }> => {
      const id = cleanId(target);
      const r = await page.evaluate(FIND_EL_EXPR(id));
      if (!r) throw new ElementNotFound(`العنصر [${id}] غير موجود في الصفحة الحالية (ربما تغيّرت الصفحة).`);
      return r as { x: number; y: number; opens: boolean };
    };
    const evalOnEl = async (fnBody: string, arg: string): Promise<any> => {
      const id = cleanId(target);
      return page.evaluate(`(() => {
        const e = document.querySelector('[data-ai-id="${id.replace(/"/g, "")}"]');
        if (!e) return { __notfound: true };
        ${fnBody}
      })()`);
    };

    if (act === "goto") {
      let url = target;
      if (!url.startsWith("http")) url = "https://" + url;
      try { await page.navigate(url, 45000); }
      catch (e) {
        if (/timeout/i.test(String(e instanceof Error ? e.message : e))) note = "⏱️ انتهت مهلة تحميل الصفحة، هذا ما تحمّل حتى الآن.\n";
        else throw e;
      }
      await settle(page, 3000);
    } else if (act === "click") {
      const el = await findEl();
      try { await page.clickAt(el.x, el.y); }
      catch { await evalOnEl("e.click(); return true;", ""); }
      if (el.opens) { const t0 = Date.now(); while (!popupId && Date.now() - t0 < 1500) await sleep(50); }
      await settle(page, 2000);
    } else if (act === "fill") {
      const r = await evalOnEl(`const v = ${JSON.stringify(val)};
        if (e.tagName === "INPUT" || e.tagName === "TEXTAREA") {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), "value")?.set;
          if (setter) setter.call(e, v); else e.value = v;
          e.dispatchEvent(new Event("input", { bubbles: true }));
          e.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true };
        }
        e.focus();
        return { ok: false, focus: true };`, val);
      if (r?.__notfound) throw new ElementNotFound(`العنصر [${cleanId(target)}] غير موجود في الصفحة الحالية (ربما تغيّرت الصفحة).`);
      if (!r?.ok) await page.insertText(val);
      await settle(page, 800);
    } else if (act === "select") {
      const r = await evalOnEl(`const v = ${JSON.stringify(val)};
        const opts = Array.from(e.options ?? []);
        const o = opts.find((x) => x.value === v || x.text.trim() === v) ?? opts.find((x) => x.text.trim().toLowerCase().includes(v.toLowerCase()));
        if (!o) return { ok: false, options: opts.map((x) => x.text.trim()).slice(0, 30) };
        e.value = o.value;
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, options: [] };`, val);
      if (r?.__notfound) throw new ElementNotFound(`العنصر [${cleanId(target)}] غير موجود في الصفحة الحالية (ربما تغيّرت الصفحة).`);
      if (!r?.ok) return `⚠️ الخيار "${val}" غير موجود في القائمة. الخيارات المتاحة: ${(r?.options ?? []).join(" | ")}`;
      await settle(page, 1500);
    } else if (act === "press_enter" || act === "press_key") {
      const key = act === "press_enter" ? "Enter" : (val || target || "").trim();
      if (!key) throw new Error("press_key يتطلب اسم المفتاح في value (مثل Escape أو Tab أو ArrowDown)");
      await page.pressKey(key);
      await settle(page, 2500);
    } else if (act === "back") {
      const ok = await page.goBack();
      if (!ok) note = "↩️ لا يوجد سجل للرجوع إليه في هذا التبويب.\n";
      await settle(page, 2000);
    } else if (act === "close_tab") {
      if (sess.targets.length < 2) return "⚠️ لا يوجد تبويب سابق للعودة إليه.";
      const cur = sess.targets.pop()!;
      await ctx.cdp.closeTarget(cur);
      page = await ctx.pages.get(sess.targets[sess.targets.length - 1]) ?? page;
      note = "🗂️ أُغلق التبويب الحالي وعدتُ للتبويب السابق.\n";
      await settle(page, 1500);
    } else if (act === "extract_links") {
      const filter = (val || target || "").toLowerCase();
      const links: Array<{ t: string; h: string }> = await page.evaluate(`(() => {
        const out = []; const seen = new Set();
        document.querySelectorAll("a[href]").forEach((a) => {
          const h = a.href; const t = (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\\s+/g, " ").slice(0, 90);
          if (!h.startsWith("http") || !t || seen.has(h)) return; seen.add(h); out.push({ t, h });
        });
        return out;
      })()`);
      const picked = (links ?? []).filter((l) => !filter || l.t.toLowerCase().includes(filter) || l.h.toLowerCase().includes(filter)).slice(0, 60);
      const title = await page.title().catch(() => "");
      return `الرابط الحالي: ${await page.url()}\nعنوان الصفحة: ${title}\n\nالروابط (${picked.length} من ${(links ?? []).length}${filter ? "، مفلترة بـ " + filter : ""}):\n` +
        picked.map((l) => `- ${l.t} → ${l.h}`).join("\n");
    } else if (act === "scroll_down") {
      await page.evaluate("window.scrollBy(0, Math.round(window.innerHeight * 0.8))");
      await sleep(250);
    } else if (act === "scroll_up") {
      await page.evaluate("window.scrollBy(0, -Math.round(window.innerHeight * 0.8))");
      await sleep(250);
    } else if (act === "wait") {
      await sleep(1000);
      await settle(page, 3000);
    } else if (act !== "vision_check" && act !== "screenshot") {
      throw new Error(`unknown action: ${act}`);
    }

    // a click/key may have opened a new tab: adopt it
    if (!popupId) {
      // maybe the popup appeared before discovery was on; check the target list
      const targets = (await ctx.cdp.listTargets().catch(() => [])).filter((t) => t.type === "page");
      const known = new Set(sess.targets);
      const extra = targets.filter((t) => !known.has(t.targetId));
      if (extra.length) popupId = extra[extra.length - 1].targetId;
    }
    if (popupId) {
      try {
        const np = new CdpPage(ctx.cdp, popupId, await ctx.cdp.attach(popupId));
        await np.init(BROWSER_UA);
        sess.targets.push(popupId);
        page = np;
        note += `🗂️ فُتح تبويب جديد وانتقلتُ إليه (${await np.url()}). للعودة للتبويب السابق استخدم close_tab.\n`;
      } catch { /* popup vanished */ }
    }

    if (act === "screenshot") {
      const shot = await page.screenshotJpeg(70);
      if (shot) await cbs.sendPhoto(chatId, shot, `📸 شاشة المتصفح الحالية\nالرابط: ${await page.url()}`);
      const { report } = await markAndCapture(page);
      return "✅ أُرسلت لقطة الشاشة الحالية للمالك.\n\n" + report;
    }
    const { report, screenshotB64 } = await markAndCapture(page, { shot: act === "vision_check" });
    if (act === "vision_check") {
      const vision = screenshotB64
        ? await cbs.analyzeImage(screenshotB64, val || "افحص شاشة المتصفح المرقمة بدقة: اقرأ الصور أو الكابتشا وحدد أرقام المربعات الحمراء الصحيحة للنقر أو الإدخال.")
        : "⚠️ تعذّر التقاط لقطة شاشة.";
      return `👁️ تحليل نموذج الرؤية البصرية للشاشة:\n${vision}\n\n${report}`;
    }
    return note + report;
  } finally {
    ctx.cdp.close();
  }
}

// One browser action against the session stored in state; creates the session on
// first use. On unexpected failure, destroys and recreates the session once.
export async function browserAction(
  env: BrowserEnv,
  sess: BrowserSessionInfo | null,
  chatId: number,
  act: string,
  target: string,
  val: string,
  cbs: BrowserCbs,
): Promise<{ out: string; sess: BrowserSessionInfo | null }> {
  if (!sess) {
    const created = await createSession(env);
    sess = { ...created, targets: [] };
  }
  try {
    const out = await actOnce(env, sess, chatId, act, target, val, cbs);
    return { out, sess };
  } catch (err) {
    if (err instanceof ElementNotFound) {
      try {
        const ctx = await connectCtx(sess);
        const state = (await markAndCapture(ctx.page).catch(() => ({ report: "" }))).report;
        ctx.cdp.close();
        return { out: `⚠️ ${err.message} اختر رقماً من القائمة الحالية أدناه.\n\n${state}`, sess };
      } catch { return { out: `⚠️ ${err.message}`, sess }; }
    }
    // session may be dead: destroy and retry once with a fresh one
    await destroySession(env, sess);
    try {
      const created = await createSession(env);
      sess = { ...created, targets: [] };
      const out = await actOnce(env, sess, chatId, act, target, val, cbs);
      return { out, sess };
    } catch (err2) {
      return { out: `حدث خطأ أثناء تنفيذ حركة المتصفح (${act}): ${err2 instanceof Error ? err2.message : String(err2)}`, sess: null };
    }
  }
}

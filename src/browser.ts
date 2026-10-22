// Browser controller - extracted from index.ts on 2026-10-21 (index.ts was over its size cap) and made dependency-injected.
// Changes vs. the old inline version:
//  * adaptive settle (network-idle, capped) instead of fixed 1.5s + 2s sleeps after every action
//  * screenshot only when it is actually used (vision_check / screenshot) instead of on every action
//  * "element not found" no longer destroys the live session: it returns the fresh page state so the model can recover
//  * Steel fallback works even when KERNEL_API_KEY is absent
//  * long fill() values are set natively instead of typing char by char
//  * goto timeouts degrade gracefully (show whatever loaded)
// Round 2 (2026-10-21): SoM v2 report (hrefs, values, overlay warning, scroll position), new-tab (popup) adoption,
//  new actions: back, close_tab, press_key, select, extract_links
import { somJs } from "./som.ts";
import { steelConfigured, steelCreateSession, steelDestroySession } from "./steel.ts";

// deno-lint-ignore no-explicit-any
type AnyBrowser = any;
type Session = { sessionId: string; cdpWsUrl: string };

export interface BrowserDeps {
  kernelApiKey: string;
  kernelBase?: string;
  userAgent: string;
  kvGet: (k: string) => Promise<string | null>;
  kvSet: (k: string, v: string) => Promise<void>;
  tgSendPhoto: (chatId: number, b64Png: string, caption: string) => Promise<void>;
  analyzeImage: (b64Png: string, prompt: string) => Promise<string>;
  // test seams (defaults are the production implementations)
  loadPuppeteer?: () => Promise<AnyBrowser>;
  steel?: { configured: () => boolean; create: () => Promise<Session>; destroy: (id: string) => Promise<void> };
  fetchFn?: typeof fetch;
}

class ElementNotFound extends Error {}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createBrowser(deps: BrowserDeps) {
  const KERNEL_BASE = deps.kernelBase ?? "https://api.onkernel.com";
  const doFetch = deps.fetchFn ?? fetch;
  const steel = deps.steel ?? { configured: steelConfigured, create: steelCreateSession, destroy: steelDestroySession };
  const loadPuppeteer = deps.loadPuppeteer ?? (async () => (await import("puppeteer-core")).default);

  let live: { sessionId: string; browser: AnyBrowser; page: AnyBrowser; provider?: string } | null = null;
  let pendingPopup: AnyBrowser | null = null; // page opened by target=_blank / window.open, adopted on the next observation
  let tabStack: AnyBrowser[] = [];            // previous tabs, so close_tab can return to them
  const watchPopups = (p: AnyBrowser) => { try { p.on?.("popup", (np: AnyBrowser) => { pendingPopup = np; }); } catch { /* best effort */ } };

  async function kernelCreate(): Promise<Session> {
    const res = await doFetch(`${KERNEL_BASE}/browsers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.kernelApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ headless: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Kernel create failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
    const sessionId = body.session_id ?? body.id ?? body.sessionId;
    const cdpWsUrl = body.cdp_ws_url ?? body.cdpWsUrl;
    if (!sessionId || !cdpWsUrl) throw new Error("Kernel returned an unexpected session shape");
    return { sessionId: String(sessionId), cdpWsUrl: String(cdpWsUrl) };
  }

  async function kernelDestroy(sessionId: string): Promise<void> {
    try {
      await doFetch(`${KERNEL_BASE}/browsers/${sessionId}`, { method: "DELETE", headers: { Authorization: `Bearer ${deps.kernelApiKey}` } });
    } catch { /* cleanup must not mask the real error */ }
  }

  async function destroySession(id: string, provider?: string): Promise<void> {
    if (provider === "steel") await steel.destroy(id); else await kernelDestroy(id);
  }

  async function ensureBrowser(): Promise<AnyBrowser> {
    if (!deps.kernelApiKey && !steel.configured()) throw new Error("لا KERNEL_API_KEY ولا STEEL_API_KEY مضبوط");
    if (live) {
      try { if (live.page && !live.page.isClosed()) return live.page; } catch { /* recreate */ }
      try { await live.browser?.disconnect(); } catch { /* gone */ }
      await destroySession(live.sessionId, live.provider);
      live = null; tabStack = []; pendingPopup = null;
    }
    let session: Session | null = null;
    let provider = "kernel";
    if (deps.kernelApiKey) {
      try { session = await kernelCreate(); }
      catch (e) {
        console.error("[browser] Kernel create failed, falling back to Steel:", e);
        if (!steel.configured()) throw e;
      }
    }
    if (!session) { session = await steel.create(); provider = "steel"; }
    console.log(`[browser] session via ${provider}: ${session.sessionId}`);
    const puppeteer = await loadPuppeteer();
    let browser: AnyBrowser = null;
    try {
      browser = await puppeteer.connect({ browserWSEndpoint: session.cdpWsUrl, defaultViewport: { width: 1280, height: 800 } });
      const [page, saved] = await Promise.all([browser.newPage(), deps.kvGet("browser_cookies").catch(() => null)]);
      await page.setUserAgent(deps.userAgent);
      try {
        const cookies = saved ? JSON.parse(saved) : null;
        if (Array.isArray(cookies) && cookies.length) await page.setCookie(...cookies);
      } catch { /* unreadable cookies: start fresh */ }
      live = { sessionId: session.sessionId, browser, page, provider };
      tabStack = []; pendingPopup = null; watchPopups(page);
      return page;
    } catch (err) {
      try { await browser?.disconnect(); } catch { /* gone */ }
      await destroySession(session.sessionId, provider);
      throw err;
    }
  }

  async function resetBrowser(): Promise<void> {
    if (!live) return;
    try { await live.browser?.disconnect(); } catch { /* gone */ }
    await destroySession(live.sessionId, live.provider);
    live = null; tabStack = []; pendingPopup = null;
  }

  function livePage(): AnyBrowser | null {
    try { return live && live.page && !live.page.isClosed() ? live.page : null; } catch { return null; }
  }

  async function saveCookies(page: AnyBrowser): Promise<void> {
    try { await deps.kvSet("browser_cookies", JSON.stringify(await page.cookies())); } catch { /* never mask the real action result */ }
  }

  // Wait until the network is quiet (capped), instead of a fixed sleep.
  async function settle(page: AnyBrowser, maxMs: number): Promise<void> {
    const idle = typeof page.waitForNetworkIdle === "function"
      ? page.waitForNetworkIdle({ idleTime: 400, timeout: maxMs }).catch(() => {})
      : sleep(Math.min(maxMs, 600));
    await Promise.race([idle, sleep(maxMs)]);
    await sleep(100);
  }

  async function markAndCapture(page: AnyBrowser, opts: { shot?: boolean } = {}): Promise<{ report: string; screenshotB64: string }> {
    // deno-lint-ignore no-explicit-any
    let som: any = { items: [], blocked: 0, overlayText: "", scrollY: 0, docH: 0, vh: 0 };
    let pageText = "";
    const scan = async () => {
      try {
        const r = await page.evaluate(somJs);
        som = Array.isArray(r) ? { ...som, items: r } : { ...som, ...(r ?? {}) }; // array = legacy shape
      } catch { som = { ...som, items: [] }; }
      try { pageText = await page.evaluate(() => document.body.innerText.slice(0, 3500)); } catch { pageText = ""; }
    };
    await scan();
    // Adaptive: a near-empty page is probably still rendering - give it one more bounded chance.
    if (som.items.length === 0 && pageText.length < 80) { await settle(page, 2000); await scan(); }
    const screenshotB64: string = opts.shot ? await page.screenshot({ encoding: "base64" }) : "";
    const lines = (som.items as Array<Record<string, unknown>>).slice(0, 100).map((it) => {
      let l = `[${it.id}]${it.pos ? " " + it.pos : ""} <${it.tag} ${it.type}>: ${it.text}`;
      if (it.href) l += ` → ${it.href}`;
      if (it.val) l += ` (قيمة: ${it.val})`;
      if (it.checked !== undefined) l += it.checked ? " ☑" : " ☐";
      if (it.disabled) l += " (معطّل)";
      return l;
    });
    const title = await page.title().catch(() => "");
    const more = som.docH && som.vh && som.scrollY + som.vh < som.docH - 20;
    const scrollLine = som.docH ? `موضع التمرير: ${som.scrollY}/${Math.max(0, som.docH - som.vh)}px${more ? " (يوجد المزيد أسفل الصفحة)" : " (نهاية الصفحة)"}\n` : "";
    const overlayLine = som.blocked
      ? `⚠️ تراكب/نافذة تغطي الصفحة ("${som.overlayText}") وتحجب ${som.blocked} عنصراً، فالعناصر المحجوبة غير مدرجة. تعامل مع النافذة أولاً (قبول/إغلاق) ثم تابع.\n`
      : "";
    const report =
      `الرابط الحالي: ${page.url()}\n` +
      `عنوان الصفحة: ${title}\n` +
      scrollLine + overlayLine + `\n` +
      `--- النص الظاهر في الصفحة ---\n${pageText}\n\n` +
      `--- العناصر التفاعلية المرقمة (استخدم الرقم فقط في target عند النقر أو الكتابة؛ ↓/↑ = خارج الشاشة) ---\n${lines.join("\n")}`;
    return { report, screenshotB64 };
  }

  const cleanId = (target: string) => String(target).replace(/^[\[\]\s]+|[\[\]\s]+$/g, "");

  // Adopt a tab opened by target=_blank / window.open so the agent follows the page the site actually opened.
  async function adoptPopup(): Promise<string> {
    if (!pendingPopup || !live) return "";
    const p = pendingPopup; pendingPopup = null;
    try { if (p.isClosed()) return ""; } catch { return ""; }
    try { await p.setUserAgent?.(deps.userAgent); } catch { /* best effort */ }
    await settle(p, 2500);
    tabStack.push(live.page); live.page = p; watchPopups(p);
    try { await p.bringToFront?.(); } catch { /* headless may not support it */ }
    return `🗂️ فُتح تبويب جديد وانتقلتُ إليه (${p.url()}). للعودة للتبويب السابق استخدم close_tab.\n`;
  }

  async function actOnce(chatId: number, act: string, target: string, val: string): Promise<string> {
    let page = await ensureBrowser();
    let note = "";
    const findEl = async (): Promise<AnyBrowser> => {
      const id = cleanId(target);
      const el = await page.$(`[data-ai-id="${id}"]`);
      if (!el) throw new ElementNotFound(`العنصر [${id}] غير موجود في الصفحة الحالية (ربما تغيّرت الصفحة).`);
      await el.evaluate((e: AnyBrowser) => e.scrollIntoView({ block: "center" }));
      return el;
    };

    if (act === "goto") {
      let url = target;
      if (!url.startsWith("http")) url = "https://" + url;
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
      } catch (e) {
        if (/timeout/i.test(String(e instanceof Error ? e.message : e))) note = "⏱️ انتهت مهلة تحميل الصفحة، هذا ما تحمّل حتى الآن.\n";
        else throw e;
      }
      await settle(page, 3000);
    } else if (act === "click") {
      const el = await findEl();
      // Will this click open a new tab? Only then is it worth waiting for the popup event.
      const opens: boolean = await el.evaluate((e: AnyBrowser) => {
        const a = e.closest?.("a");
        return (a && a.target === "_blank") || /window\.open/.test(e.getAttribute?.("onclick") ?? "");
      }).catch(() => false);
      try { await el.click(); } catch { await el.evaluate((e: AnyBrowser) => e.click()); }
      if (opens && !pendingPopup) { const t0 = Date.now(); while (!pendingPopup && Date.now() - t0 < 1500) await sleep(50); }
      await settle(page, 2000);
      await saveCookies(page);
    } else if (act === "fill") {
      const el = await findEl();
      let done = false;
      if (val.length > 40) {
        done = await el.evaluate((e: AnyBrowser, v: string) => {
          if (e.tagName !== "INPUT" && e.tagName !== "TEXTAREA") return false;
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(e), "value")?.set;
          if (setter) setter.call(e, v); else e.value = v;
          e.dispatchEvent(new Event("input", { bubbles: true }));
          e.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }, val).catch(() => false);
      }
      if (!done) { await el.click({ clickCount: 3 }); await el.type(val, { delay: 8 }); }
    } else if (act === "select") {
      const el = await findEl();
      const r: { ok: boolean; options: string[] } = await el.evaluate((e: AnyBrowser, v: string) => {
        const opts = Array.from(e.options ?? []) as AnyBrowser[];
        const o = opts.find((x) => x.value === v || x.text.trim() === v) ?? opts.find((x) => x.text.trim().toLowerCase().includes(v.toLowerCase()));
        if (!o) return { ok: false, options: opts.map((x) => x.text.trim()).slice(0, 30) };
        e.value = o.value;
        e.dispatchEvent(new Event("input", { bubbles: true }));
        e.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, options: [] };
      }, val);
      if (!r.ok) return `⚠️ الخيار "${val}" غير موجود في القائمة. الخيارات المتاحة: ${r.options.join(" | ")}`;
      await settle(page, 1500);
    } else if (act === "press_enter" || act === "press_key") {
      const key = act === "press_enter" ? "Enter" : (val || target || "").trim();
      if (!key) throw new Error("press_key يتطلب اسم المفتاح في value (مثل Escape أو Tab أو ArrowDown)");
      await page.keyboard.press(key);
      await settle(page, 2500);
      await saveCookies(page);
    } else if (act === "back") {
      const r = await page.goBack({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
      if (!r) note = "↩️ لا يوجد سجل للرجوع إليه في هذا التبويب.\n";
      await settle(page, 2000);
    } else if (act === "close_tab") {
      const prev = tabStack.pop();
      if (!prev || !live) return "⚠️ لا يوجد تبويب سابق للعودة إليه.";
      try { await page.close(); } catch { /* already closed */ }
      live.page = prev; page = prev;
      try { await prev.bringToFront?.(); } catch { /* best effort */ }
      note = "🗂️ أُغلق التبويب الحالي وعدتُ للتبويب السابق.\n";
    } else if (act === "extract_links") {
      const filter = (val || target || "").toLowerCase();
      const links: Array<{ t: string; h: string }> = await page.evaluate(() => {
        const out: Array<{ t: string; h: string }> = []; const seen = new Set<string>();
        document.querySelectorAll("a[href]").forEach((a: AnyBrowser) => {
          const h = a.href as string; const t = (a.innerText || a.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 90);
          if (!h.startsWith("http") || !t || seen.has(h)) return; seen.add(h); out.push({ t, h });
        });
        return out;
      });
      const picked = links.filter((l) => !filter || l.t.toLowerCase().includes(filter) || l.h.toLowerCase().includes(filter)).slice(0, 60);
      const title = await page.title().catch(() => "");
      return `الرابط الحالي: ${page.url()}\nعنوان الصفحة: ${title}\n\nالروابط (${picked.length} من ${links.length}${filter ? "، مفلترة بـ " + filter : ""}):\n` +
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

    // a click/key may have opened a new tab: follow it
    const popupNote = await adoptPopup();
    if (popupNote) { note += popupNote; page = live!.page; }

    if (act === "screenshot") {
      const cleanShot: string = await page.screenshot({ encoding: "base64" });
      await deps.tgSendPhoto(chatId, cleanShot, `📸 شاشة المتصفح الحالية\nالرابط: ${page.url()}`);
      const { report } = await markAndCapture(page);
      return "✅ أُرسلت لقطة الشاشة الحالية للمالك.\n\n" + report;
    }
    const { report, screenshotB64 } = await markAndCapture(page, { shot: act === "vision_check" });
    if (act === "vision_check") {
      const vision = await deps.analyzeImage(
        screenshotB64,
        val || "افحص شاشة المتصفح المرقمة بدقة: اقرأ الصور أو الكابتشا وحدد أرقام المربعات الحمراء الصحيحة للنقر أو الإدخال.",
      );
      return `👁️ تحليل نموذج الرؤية البصرية للشاشة:\n${vision}\n\n${report}`;
    }
    return note + report;
  }

  async function browserAction(chatId: number, act: string, target: string, val: string): Promise<string> {
    const t0 = Date.now();
    try {
      const out = await actOnce(chatId, act, target, val);
      console.log(`[browser] ${act} ok ${Date.now() - t0}ms`);
      return out;
    } catch (err) {
      if (err instanceof ElementNotFound) {
        // The session is healthy; only the element id is stale. Do NOT reset - hand back the current page state instead.
        const page = livePage();
        const state = page ? (await markAndCapture(page).catch(() => ({ report: "" }))).report : "";
        console.log(`[browser] ${act} element-not-found ${Date.now() - t0}ms`);
        return `⚠️ ${err.message} اختر رقماً من القائمة الحالية أدناه.\n\n${state}`;
      }
      try {
        await resetBrowser();
        const out = await actOnce(chatId, act, target, val);
        console.log(`[browser] ${act} ok-after-reset ${Date.now() - t0}ms`);
        return out;
      } catch (err2) {
        return `حدث خطأ أثناء تنفيذ حركة المتصفح (${act}): ${err2 instanceof Error ? err2.message : String(err2)}`;
      }
    }
  }

  return { browserAction, markAndCapture, resetBrowser, ensureBrowser, livePage };
}

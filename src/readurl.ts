// read_url: fetch a page and return clean readable text + links WITHOUT launching a cloud browser (much faster for static pages).
// Safety: only http(s); blocks private/loopback/link-local hosts (SSRF) on every redirect hop; size + time capped.
import { BROWSER_UA } from "./websearch.ts";

export function isPrivateHost(hostRaw: string): boolean {
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(":")) { // IPv6
    if (host === "::1" || host === "::") return true;
    if (/^f[cd]/.test(host) || /^fe[89ab]/.test(host)) return true;
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (mapped) return isPrivateHost(mapped[1]);
    if (/^::ffff:[0-9a-f]+:[0-9a-f]+$/.test(host)) return true; // hex-mapped v4: refuse rather than parse
  }
  return false;
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»" };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") { const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(cp); } catch { return m; } }
    return named[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string, baseUrl: string): { title: string; description: string; text: string; links: Array<{ t: string; h: string }> } {
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim());
  const description = decodeEntities((html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i)?.[1] ?? "").trim());
  let h = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, "");
  const main = h.match(/<article\b[\s\S]*?<\/article>/i)?.[0] ?? h.match(/<main\b[\s\S]*?<\/main>/i)?.[0];
  if (main && main.length > 300) h = main; else h = h.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, "");
  const links: Array<{ t: string; h: string }> = []; const seen = new Set<string>();
  for (const m of h.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const t = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 80);
    if (!t || /^(javascript:|mailto:|tel:|#)/i.test(m[1])) continue;
    let abs: string; try { abs = new URL(decodeEntities(m[1]), baseUrl).href; } catch { continue; }
    if (seen.has(abs)) continue; seen.add(abs); links.push({ t, h: abs });
  }
  const text = decodeEntities(
    h.replace(/<h[1-6][^>]*>/gi, "\n# ").replace(/<li[^>]*>/gi, "\n- ").replace(/<\/(p|div|tr|section|h[1-6]|ul|ol|table)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "),
  ).split("\n").map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim()).filter(Boolean).join("\n");
  return { title, description, text, links };
}

export interface ReadUrlOpts { fetchFn?: typeof fetch; allowPrivate?: boolean; timeoutMs?: number; maxChars?: number; maxBytes?: number }

export async function readUrl(rawUrl: string, o: ReadUrlOpts = {}): Promise<string> {
  const doFetch = o.fetchFn ?? fetch;
  const maxChars = o.maxChars ?? 7000, maxBytes = o.maxBytes ?? 1_500_000, timeoutMs = o.timeoutMs ?? 12000;
  let url = String(rawUrl ?? "").trim();
  if (!url) return "⚠️ read_url يتطلب رابطاً.";
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  let u: URL; try { u = new URL(url); } catch { return `⚠️ رابط غير صالح: ${rawUrl}`; }
  let res: Response | null = null;
  try {
    for (let hop = 0; hop < 5; hop++) {
      if (!/^https?:$/.test(u.protocol)) return "⚠️ يُسمح بروابط http/https فقط.";
      if (!o.allowPrivate && isPrivateHost(u.hostname)) return "⚠️ مرفوض: لا يُسمح بقراءة عناوين داخلية/محلية.";
      res = await doFetch(u.href, {
        redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
        headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5", "Accept-Language": "ar,en;q=0.8" },
      });
      const loc = res.headers?.get?.("location");
      if (res.status >= 300 && res.status < 400 && loc) { u = new URL(loc, u); res = null; continue; }
      break;
    }
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return `⚠️ تعذّر جلب الصفحة (${/timeout|abort/i.test(m) ? "انتهت المهلة" : m.slice(0, 120)}). جرّب browser_step.`;
  }
  if (!res) return "⚠️ تحويلات كثيرة جداً.";
  if (!res.ok) return `⚠️ الخادم أعاد HTTP ${res.status}${[401, 403, 429, 503].includes(res.status) ? " (قد يحجب الأدوات الآلية: جرّب browser_step)" : ""}.`;
  const ct = (res.headers?.get?.("content-type") ?? "").toLowerCase();
  if (ct.includes("pdf")) return `📄 هذا ملف PDF (${u.href}). استخدم أداة قراءة PDF بدلاً من read_url.`;
  if (ct && !/(text|json|xml|html)/.test(ct)) return `⚠️ نوع محتوى غير مدعوم: ${ct.split(";")[0]}`;
  let body = "";
  if (res.body && typeof (res.body as ReadableStream).getReader === "function") {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader(); const dec = new TextDecoder(); let got = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; got += value.length; body += dec.decode(value, { stream: true }); if (got >= maxBytes) { await reader.cancel().catch(() => {}); break; } }
  } else body = (await res.text()).slice(0, maxBytes);
  if (ct.includes("json")) { try { body = JSON.stringify(JSON.parse(body), null, 1); } catch { /* keep raw */ } return `الرابط: ${u.href}\n\n${body.slice(0, maxChars)}${body.length > maxChars ? "\n…(اقتُطع)" : ""}`; }
  if (!ct.includes("html") && !/^\s*<(!doctype|html)/i.test(body)) return `الرابط: ${u.href}\n\n${body.slice(0, maxChars)}${body.length > maxChars ? "\n…(اقتُطع)" : ""}`;
  const { title, description, text, links } = htmlToText(body, u.href);
  const clipped = text.length > maxChars;
  const hint = text.length < 200 ? "\n\n(المحتوى قصير جداً؛ قد تكون الصفحة تعتمد على JavaScript: استخدم browser_step أو browse_task.)" : "";
  return `الرابط: ${u.href}\nالعنوان: ${title}${description ? `\nالوصف: ${description}` : ""}\n\n${text.slice(0, maxChars)}${clipped ? "\n…(اقتُطع؛ الصفحة أطول)" : ""}${hint}` +
    (links.length ? `\n\nروابط (${Math.min(links.length, 25)} من ${links.length}):\n${links.slice(0, 25).map((l) => `- ${l.t} → ${l.h}`).join("\n")}` : "");
}

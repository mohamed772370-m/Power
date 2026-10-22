
import puppeteer from "puppeteer-core";
export async function launch() {
  return puppeteer.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
}
// createBrowser() wired to a REAL chromium (connect via its CDP endpoint, like Kernel/Steel would provide)
export async function makeReal(createBrowser, chrome, extra = {}) {
  const kv = new Map(); const photos = [];
  const b = createBrowser({
    kernelApiKey: "k", userAgent: "Mozilla/5.0 test", loadPuppeteer: async () => puppeteer,
    kvGet: async (k) => kv.get(k) ?? null, kvSet: async (k, v) => { kv.set(k, v); },
    tgSendPhoto: async (c, s, cap) => { photos.push(cap); }, analyzeImage: async () => "VISION",
    fetchFn: async () => ({ ok: true, json: async () => ({ session_id: "real", cdp_ws_url: chrome.wsEndpoint() }) }),
    steel: { configured: () => false, create: async () => { throw new Error("n/a"); }, destroy: async () => {} },
    ...extra,
  });
  return { b, kv, photos };
}
export const pptr = puppeteer;

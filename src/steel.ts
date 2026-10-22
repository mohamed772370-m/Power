// Steel.dev - BACKUP cloud browser provider (Kernel stays primary). Approved by owner 2026-10-18.
// Free Launch plan: one-time $30 credits, 15-min session cap, no card. CDP over wss://connect.steel.dev.
const STEEL_API_KEY = (process.env.STEEL_API_KEY ?? "").trim();
const STEEL_BASE = "https://api.steel.dev/v1";

export function steelConfigured(): boolean { return STEEL_API_KEY.length > 0; }

export async function steelCreateSession(): Promise<{ sessionId: string; cdpWsUrl: string }> {
  if (!STEEL_API_KEY) throw new Error("STEEL_API_KEY is not set");
  const res = await fetch(`${STEEL_BASE}/sessions`, {
    method: "POST",
    headers: { "steel-api-key": STEEL_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Steel create failed (${res.status}): ${JSON.stringify(body).slice(0, 200)}`);
  const sessionId = body.id ?? body.session_id ?? body.sessionId;
  if (!sessionId) throw new Error("Steel returned an unexpected session shape");
  return {
    sessionId: String(sessionId),
    cdpWsUrl: `wss://connect.steel.dev?apiKey=${encodeURIComponent(STEEL_API_KEY)}&sessionId=${encodeURIComponent(String(sessionId))}`,
  };
}

export async function steelDestroySession(sessionId: string): Promise<void> {
  try {
    await fetch(`${STEEL_BASE}/sessions/${sessionId}/release`, {
      method: "POST",
      headers: { "steel-api-key": STEEL_API_KEY },
    });
  } catch { /* cleanup must not mask the real error */ }
}

// deno-lint-ignore no-explicit-any
export async function steelSelftest(mark: (page: any) => Promise<{ report: string }>): Promise<string> {
  const s = await steelCreateSession();
  // deno-lint-ignore no-explicit-any
  const puppeteer = (await import("puppeteer-core")).default as any;
  const browser = await puppeteer.connect({ browserWSEndpoint: s.cdpWsUrl, defaultViewport: { width: 1280, height: 800 } });
  try {
    const page = await browser.newPage();
    await page.goto("https://example.com", { waitUntil: "domcontentloaded", timeout: 30000 });
    const { report } = await mark(page);
    return `STEEL OK title=${await page.title()} | ${report.slice(0, 300)}`;
  } finally {
    try { await browser.disconnect(); } catch { /* gone */ }
    await steelDestroySession(s.sessionId);
  }
}

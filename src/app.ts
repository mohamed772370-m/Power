// Wires everything together: HTTP server (health + Telegram webhook), polling fallback, LLM, browsers, solver, bot.
import http from "node:http";
import type { Config } from "./config.ts";
import { createLlm } from "./llm.ts";
import { createTelegram } from "./telegram.ts";
import { createBrowser } from "./browser.ts";
import { createBot } from "./bot.ts";
import { Semaphore, solveTask } from "./solve.ts";
import { readUrl } from "./readurl.ts";
import { webSearch, BROWSER_UA } from "./websearch.ts";

export interface AppOverrides { fetchFn?: typeof fetch; loadPuppeteer?: () => Promise<any>; telegramBase?: string; nimBase?: string; kernelBase?: string; steel?: any; statusThrottleMs?: number; log?: (m: string) => void }

export function createApp(cfg: Config, over: AppOverrides = {}) {
  const log = over.log ?? ((m: string) => console.log(`[agent] ${m}`));
  const llm = createLlm({ apiKey: cfg.nvidiaKey, fetchFn: over.fetchFn, baseUrl: over.nimBase, rpm: cfg.nimRpm, models: { ...(cfg.models.leader ? { leader: cfg.models.leader } : {}), ...(cfg.models.fallback ? { fallback: cfg.models.fallback } : {}), ...(cfg.models.vision ? { vision: cfg.models.vision } : {}) } });
  const tg = createTelegram(cfg.telegramToken, over.fetchFn, over.telegramBase);
  const sem = new Semaphore(cfg.maxParallel);
  let sessions = 0;
  const makeBrowser = () => {
    const ctl = createBrowser({
      kernelApiKey: cfg.kernelKey, kernelBase: over.kernelBase, userAgent: BROWSER_UA,
      kvGet: async () => null, kvSet: async () => {}, // every task starts from a clean private browser (no cookie sharing between parallel agents)
      tgSendPhoto: (c, b, cap) => tg.sendPhoto(c, b, cap).catch(() => {}),
      analyzeImage: (b, p) => llm.vision(b, p),
      loadPuppeteer: over.loadPuppeteer, fetchFn: over.fetchFn, steel: over.steel,
    });
    return {
      browserAction: async (c: number, a: string, t: string, v: string) => { if (!ctl.livePage()) sessions++; return ctl.browserAction(c, a, t, v); },
      resetBrowser: async () => { if (ctl.livePage()) sessions--; await ctl.resetBrowser(); },
    };
  };
  const solve = (goal: string, ctx: Parameters<typeof solveTask>[2]) =>
    solveTask(goal, { chat: (m, t, temp) => llm.chat(m, t, temp), makeBrowser, readUrl: (u) => readUrl(u), webSearch: (q) => webSearch(q), sem, maxSubtasks: Math.max(2, cfg.maxParallel + 2) }, ctx);
  const bot = createBot({ tg, solve, allowed: cfg.allowedIds, statusThrottleMs: over.statusThrottleMs, jobTimeoutMs: cfg.jobTimeoutMs });

  const server = http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (url === "/" || url === "/health")) {
      res.writeHead(200, { "content-type": "application/json" }); return void res.end(JSON.stringify({ ok: true, jobs: bot.jobs.size, up: Math.round(process.uptime()) }));
    }
    if (req.method === "POST" && url === "/telegram") {
      if (req.headers["x-telegram-bot-api-secret-token"] !== cfg.webhookSecret) { res.writeHead(403); return void res.end("forbidden"); }
      let body = ""; let size = 0;
      req.on("data", (c: Buffer) => { size += c.length; if (size > 1_000_000) req.destroy(); else body += c; });
      req.on("end", () => {
        res.writeHead(200); res.end("ok"); // answer Telegram immediately; work continues in the background
        try { void bot.handleUpdate(JSON.parse(body)).catch((e) => log(`update error: ${e}`)); } catch { log("bad webhook body"); }
      });
      return;
    }
    res.writeHead(404); res.end("not found");
  });

  let stopped = false; const pollAbort = new AbortController();
  async function poll(): Promise<void> {
    await tg.deleteWebhook().catch(() => {});
    let offset = 0;
    while (!stopped) {
      try {
        const ups = await tg.getUpdates(offset, 25, pollAbort.signal);
        for (const u of ups) { offset = Math.max(offset, u.update_id + 1); void bot.handleUpdate(u).catch((e) => log(`update error: ${e}`)); }
      } catch (e) { if (stopped) break; log(`polling error: ${e}`); await new Promise((r) => setTimeout(r, 3000)); }
    }
  }
  async function registerWebhook(): Promise<void> {
    for (let i = 1; i <= 5; i++) {
      try { await tg.setWebhook(`${cfg.publicUrl}/telegram`, cfg.webhookSecret); log(`webhook set: ${cfg.publicUrl}/telegram`); return; }
      catch (e) { log(`setWebhook attempt ${i} failed: ${e}`); await new Promise((r) => setTimeout(r, 2000 * i)); }
    }
    log("WARNING: webhook registration failed after 5 attempts");
  }

  return {
    server, bot, llm, tg, sessionsOpen: () => sessions,
    async start(): Promise<number> {
      const port: number = await new Promise((resolve) => server.listen(cfg.port, "0.0.0.0", () => resolve((server.address() as any).port)));
      log(`listening on :${port} (${cfg.publicUrl ? "webhook" : "polling"} mode; parallel=${cfg.maxParallel})`);
      if (cfg.publicUrl) void registerWebhook(); else void poll();
      return port;
    },
    async stop(): Promise<void> {
      stopped = true; pollAbort.abort(); await bot.stopAll();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

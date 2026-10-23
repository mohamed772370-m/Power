// Minimal Chrome DevTools Protocol client over an outbound WebSocket (workerd).
// Only what the browser controller needs: targets/tabs, evaluate, navigate,
// screenshot, mouse/keyboard input, navigation history. No npm dependencies.

export interface CdpTarget { targetId: string; type: string; url: string; title: string }

interface Pending { resolve: (v: any) => void; reject: (e: Error) => void; timer: number }

export class Cdp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private eventHandlers = new Map<string, Array<(params: any, sessionId?: string) => void>>();
  private open: Promise<void>;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.open = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP WebSocket open timeout")), 20000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("CDP WebSocket error")); });
    });
    ws.addEventListener("message", (ev: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      } else if (msg.method) {
        const hs = this.eventHandlers.get(msg.method);
        if (hs) for (const h of hs) { try { h(msg.params, msg.sessionId); } catch { /* listener */ } }
      }
    });
    ws.addEventListener("close", () => {
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error("CDP WebSocket closed")); }
      this.pending.clear();
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const ws = new WebSocket(wsUrl);
    const c = new Cdp(ws);
    ws.accept();
    await c.open;
    return c;
  }

  on(method: string, h: (params: any, sessionId?: string) => void): void {
    const arr = this.eventHandlers.get(method) ?? [];
    arr.push(h);
    this.eventHandlers.set(method, arr);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 45000): Promise<any> {
    const id = this.nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, timeoutMs) as unknown as number;
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify(payload)); } catch (e) {
        this.pending.delete(id); clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  close(): void { try { this.ws.close(1000); } catch { /* gone */ } }

  // ---- target helpers ----
  async listTargets(): Promise<CdpTarget[]> {
    const r = await this.send("Target.getTargets");
    return (r?.targetInfos ?? []) as CdpTarget[];
  }
  async createTarget(url = "about:blank"): Promise<string> {
    const r = await this.send("Target.createTarget", { url });
    return String(r.targetId);
  }
  async attach(targetId: string): Promise<string> {
    const r = await this.send("Target.attachToTarget", { targetId, flatten: true });
    return String(r.sessionId);
  }
  async closeTarget(targetId: string): Promise<void> {
    await this.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// One attached page (flattened session).
export class CdpPage {
  constructor(private cdp: Cdp, public targetId: string, public sessionId: string) {}

  async init(userAgent: string): Promise<void> {
    await this.cdp.send("Page.enable", {}, this.sessionId).catch(() => {});
    await this.cdp.send("Runtime.enable", {}, this.sessionId).catch(() => {});
    if (userAgent) {
      await this.cdp.send("Emulation.setUserAgentOverride", {
        userAgent,
        acceptLanguage: "ar,en;q=0.8",
      }, this.sessionId).catch(() => {});
    }
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
    }, this.sessionId).catch(() => {});
  }

  async evaluate(expression: string, timeoutMs = 30000): Promise<any> {
    const r = await this.cdp.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true,
    }, this.sessionId, timeoutMs);
    if (r?.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page JS error: ${(d.exception?.description ?? d.text ?? "exception").slice(0, 200)}`);
    }
    return r?.result?.value;
  }

  async navigate(url: string, timeoutMs = 45000): Promise<void> {
    let loaded = false;
    this.cdp.on("Page.loadEventFired", (_p, sid) => { if (sid === this.sessionId) loaded = true; });
    await this.cdp.send("Page.navigate", { url }, this.sessionId, timeoutMs);
    const t0 = Date.now();
    while (!loaded && Date.now() - t0 < timeoutMs) await sleep(100);
  }

  async waitLoadEvent(timeoutMs: number): Promise<void> {
    let loaded = false;
    this.cdp.on("Page.loadEventFired", (_p, sid) => { if (sid === this.sessionId) loaded = true; });
    const t0 = Date.now();
    while (!loaded && Date.now() - t0 < timeoutMs) await sleep(100);
  }

  async url(): Promise<string> { return String(await this.evaluate("location.href").catch(() => "") ?? ""); }
  async title(): Promise<string> { return String(await this.evaluate("document.title").catch(() => "") ?? ""); }

  async screenshotJpeg(quality = 55): Promise<string> {
    const r = await this.cdp.send("Page.captureScreenshot", { format: "jpeg", quality }, this.sessionId, 60000);
    return String(r?.data ?? "");
  }

  async goBack(): Promise<boolean> {
    const h = await this.cdp.send("Page.getNavigationHistory", {}, this.sessionId).catch(() => null);
    if (!h || h.currentIndex <= 0) return false;
    const entry = h.entries[h.currentIndex - 1];
    await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id }, this.sessionId).catch(() => {});
    return true;
  }

  async clickAt(x: number, y: number): Promise<void> {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.cdp.send("Input.dispatchMouseEvent", {
        type, x, y, button: "left", clickCount: 1,
      }, this.sessionId);
    }
  }

  async insertText(text: string): Promise<void> {
    await this.cdp.send("Input.insertText", { text }, this.sessionId);
  }

  async pressKey(key: string): Promise<void> {
    const map: Record<string, { code: string; vk: number; text?: string }> = {
      Enter: { code: "Enter", vk: 13, text: "\r" },
      Escape: { code: "Escape", vk: 27 },
      Tab: { code: "Tab", vk: 9 },
      Backspace: { code: "Backspace", vk: 8 },
      Delete: { code: "Delete", vk: 46 },
      ArrowDown: { code: "ArrowDown", vk: 40 },
      ArrowUp: { code: "ArrowUp", vk: 38 },
      ArrowLeft: { code: "ArrowLeft", vk: 37 },
      ArrowRight: { code: "ArrowRight", vk: 39 },
      Home: { code: "Home", vk: 36 },
      End: { code: "End", vk: 35 },
      PageDown: { code: "PageDown", vk: 34 },
      PageUp: { code: "PageUp", vk: 33 },
      " ": { code: "Space", vk: 32, text: " " },
    };
    const k = map[key] ?? (key.length === 1
      ? { code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key }
      : { code: key, vk: 0 });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: k.text ? "keyDown" : "rawKeyDown", key, code: k.code,
      windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, ...(k.text ? { text: k.text } : {}),
    }, this.sessionId);
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
    }, this.sessionId);
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

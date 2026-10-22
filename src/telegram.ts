// Minimal Telegram Bot API client (plain text only, no parse_mode, so no formatting errors).
export interface Telegram {
  sendMessage(chatId: number, text: string): Promise<number>;
  editMessage(chatId: number, messageId: number, text: string): Promise<void>;
  sendPhoto(chatId: number, b64Png: string, caption: string): Promise<void>;
  typing(chatId: number): Promise<void>;
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<Array<Record<string, any>>>;
  setWebhook(url: string, secret: string): Promise<void>;
  deleteWebhook(): Promise<void>;
}

export function chunkText(text: string, size = 4000): string[] {
  const out: string[] = []; let rest = String(text ?? "");
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size); if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length || !out.length) out.push(rest || "(فارغ)");
  return out;
}

export function createTelegram(token: string, fetchFn: typeof fetch = fetch, base = "https://api.telegram.org"): Telegram {
  const api = `${base}/bot${token}`;
  async function call(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<any> {
    const res = await fetchFn(`${api}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
    const data: any = await res.json().catch(() => ({ ok: false, description: `HTTP ${res.status}` }));
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description ?? res.status}`);
    return data.result;
  }
  return {
    async sendMessage(chatId, text) {
      let id = 0;
      for (const part of chunkText(text)) id = (await call("sendMessage", { chat_id: chatId, text: part, disable_web_page_preview: true }))?.message_id ?? id;
      return id;
    },
    async editMessage(chatId, messageId, text) {
      try { await call("editMessageText", { chat_id: chatId, message_id: messageId, text: text.slice(0, 4000), disable_web_page_preview: true }); }
      catch (e) { if (!/not modified/i.test(String(e))) throw e; }
    },
    async sendPhoto(chatId, b64Png, caption) {
      const bin = Buffer.from(b64Png, "base64");
      const form = new FormData();
      form.append("chat_id", String(chatId)); form.append("caption", caption.slice(0, 1000));
      form.append("photo", new Blob([bin], { type: "image/png" }), "screen.png");
      const res = await fetchFn(`${api}/sendPhoto`, { method: "POST", body: form });
      const data: any = await res.json().catch(() => ({ ok: false }));
      if (!data.ok) throw new Error(`Telegram sendPhoto: ${data.description ?? res.status}`);
    },
    async typing(chatId) { await call("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {}); },
    getUpdates: (offset, timeoutSec, signal) => call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, signal),
    async setWebhook(url, secret) { await call("setWebhook", { url, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false }); },
    async deleteWebhook() { await call("deleteWebhook", { drop_pending_updates: false }); },
  };
}

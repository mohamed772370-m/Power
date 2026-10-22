// Test world: stubs Telegram + NVIDIA NIM + Kernel at the fetch level. The browser is REAL Chromium (local test pages).
// The "LLM" is a scripted policy, so these tests verify plumbing/behaviour, not model intelligence.
import { PLAN_PROMPT, SYNTH_PROMPT } from "../src/solve.ts";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const TOKEN = "123:TEST"; export const SECRET = "sekret";

export function makeWorld({ chrome, base, latency = 0, realFetch = globalThis.fetch }) {
  const w = { tg: [], nim: [], kernel: { created: 0, deleted: 0, live: 0, peak: 0 }, msgId: 100, updatesQueue: [], planCalls: 0, synthCalls: 0, subTasks: [] };
  const urlsIn = (txt) => [...String(txt).matchAll(new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/(\\w+)", "g"))].map((m) => m[0]);
  function llm(body) {
    const names = (body.tools ?? []).map((t) => t.function.name); const msgs = body.messages; const sys = String(msgs[0]?.content ?? "");
    if (names.includes("act")) {
      w.nim.push("sub");
      const lastTool = [...msgs].reverse().find((m) => m.role === "tool")?.content ?? "";
      const task = String(msgs[1].content); if (!lastTool) w.subTasks.push(task);
      if (/عالق|stuck-test/.test(task) && lastTool) return { role: "assistant", content: null, tool_calls: [{ id: "x" + Math.random(), type: "function", function: { name: "act", arguments: JSON.stringify({ action: "wait" }) } }] };
      if (!lastTool) { const u = urlsIn(task)[0]; return { role: "assistant", content: null, tool_calls: [{ id: "c1" + Math.random(), type: "function", function: { name: "act", arguments: JSON.stringify({ action: "goto", target: u }) } }] }; }
      const lastPage = [...msgs].reverse().find((m) => m.role === "tool" && m.name === "browser_step")?.content ?? ""; const t = lastPage.match(/عنوان الصفحة: ([^\n]+)/)?.[1] ?? "?";
      const lastCall = [...msgs].reverse().find((m) => m.tool_calls)?.tool_calls?.[0]?.function?.name;
      if (lastCall === "finish") return { role: "assistant", content: null, tool_calls: [{ id: "f2" + Math.random(), type: "function", function: { name: "finish", arguments: JSON.stringify({ result: `عنوان الصفحة: ${t}`, success: true, evidence: `عنوان الصفحة: ${t}` }) } }] };
      const fake = /حقيقي|fake-evidence/.test(task) ? "اقتباس مخترع لم يظهر في أي صفحة أبداً" : `عنوان الصفحة: ${t}`;
      return { role: "assistant", content: null, tool_calls: [{ id: "f1" + Math.random(), type: "function", function: { name: "finish", arguments: JSON.stringify({ result: `عنوان الصفحة: ${t}`, success: true, evidence: fake }) } }] };
    }
    if (sys === PLAN_PROMPT) {
      w.planCalls++; w.nim.push("plan"); const urls = urlsIn(msgs[1].content);
      return { role: "assistant", content: JSON.stringify(urls.length >= 2 ? { mode: "parallel", subtasks: urls.map((u) => ({ goal: `افتح ${u} وأعد عنوان الصفحة` })) } : { mode: "single", subtasks: [{ goal: "x" }] }) };
    }
    if (sys === SYNTH_PROMPT) { w.synthCalls++; w.nim.push("synth"); return { role: "assistant", content: "الخلاصة النهائية:\n" + String(msgs[1].content).split("\n").filter((l) => l.startsWith("عنوان الصفحة") || l.startsWith("✅")).join("\n") }; }
    w.nim.push("other"); return { role: "assistant", content: "ok" };
  }
  w.fetchFn = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1")) return realFetch(url, init);
    if (u.includes("api.telegram.org")) {
      const method = u.split("/").pop(); let b = {}; try { b = JSON.parse(init.body ?? "{}"); } catch { /* multipart */ }
      w.tg.push({ method, ...b });
      if (method === "sendMessage") return json({ ok: true, result: { message_id: ++w.msgId } });
      if (method === "getUpdates") { await sleep(30); const ups = w.updatesQueue.splice(0); if (!ups.length) await sleep(120); return json({ ok: true, result: ups }); }
      return json({ ok: true, result: true });
    }
    if (u.includes("api.onkernel.com")) {
      if ((init.method ?? "GET") === "DELETE") { w.kernel.deleted++; w.kernel.live--; return json({ ok: true }); }
      w.kernel.created++; w.kernel.live++; w.kernel.peak = Math.max(w.kernel.peak, w.kernel.live);
      return json({ session_id: "k" + w.kernel.created, cdp_ws_url: chrome.wsEndpoint() });
    }
    if (u.includes("integrate.api.nvidia.com")) { if (latency) await sleep(latency); const body = JSON.parse(init.body); return json({ model: body.model, choices: [{ message: llm(body) }] }); }
    return new Response("{}", { status: 500 });
  };
  w.sent = () => w.tg.filter((x) => x.method === "sendMessage").map((x) => x.text);
  w.edits = () => w.tg.filter((x) => x.method === "editMessageText").map((x) => x.text);
  return w;
}
const json = (o) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
export const update = (text, from = 1, chat = 1, id = Math.floor(Math.random() * 1e9)) => ({ update_id: id, message: { message_id: id, from: { id: from }, chat: { id: chat }, text } });
export async function waitFor(fn, ms = 20000, step = 25) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } throw new Error("waitFor timed out"); }

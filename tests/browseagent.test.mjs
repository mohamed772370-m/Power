import assert from "node:assert/strict";
import { runBrowseTask, BROWSE_SUB_TOOLS } from "../src/browseagent.ts";
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };
const call = (name, args) => ({ content: null, tool_calls: [{ id: "c" + Math.random(), type: "function", function: { name, arguments: JSON.stringify(args) } }] });
const lastTool = (m) => [...m].reverse().find((x) => x.role === "tool")?.content ?? "";
const deps = (extra = {}) => ({ browserAction: async () => "الرابط الحالي: https://x.com\nعنوان الصفحة: X\nسعر المنتج 49 دولار", readUrl: async () => "page text", webSearch: async () => "[]", ...extra });

await t("plain text answer is accepted; finish(success:false) -> ❌; model error -> partial with progress", async () => {
  assert.equal(await runBrowseTask("g", 1, deps({ callModel: async () => ({ content: "الجواب 42" }) })), "✅ الجواب 42");
  assert.equal(await runBrowseTask("g", 1, deps({ callModel: async () => call("finish", { result: "يحتاج تسجيل دخول", success: false }) })), "❌ لم يتحقق الهدف: يحتاج تسجيل دخول");
  let k = 0; const r = await runBrowseTask("g", 1, deps({ callModel: async () => { if (k++ === 0) return call("act", { action: "goto", target: "https://x.com" }); throw new Error("NIM 429"); } }));
  assert.ok(r.startsWith("⏳") && r.includes("NIM 429") && r.includes("goto https://x.com"), r);
});
await t("EVIDENCE: literal quote from a seen page is accepted without warning; fabricated one is challenged then flagged", async () => {
  const good = []; await runBrowseTask("g", 1, deps({ callModel: async (m) => { good.push(1); return lastTool(m) ? call("finish", { result: "السعر 49", success: true, evidence: "سعر المنتج   49 دولار" }) : call("act", { action: "goto", target: "https://x.com" }); } }))
    .then((r) => assert.equal(r, "✅ السعر 49"));
  let phase = 0; const msgs = []; const r = await runBrowseTask("g", 1, deps({ callModel: async (m) => { msgs.push(lastTool(m)); phase++; if (phase === 1) return call("act", { action: "goto", target: "https://x.com" }); return call("finish", { result: "السعر 99", success: true, evidence: "سعر المنتج 99 دولار" }); } }));
  assert.ok(msgs[2].includes("الدليل غير موجود حرفياً"), msgs[2]); assert.ok(r.startsWith("✅ السعر 99") && r.includes("لم يُتحقق من الدليل"), r); assert.equal(phase, 3, "challenged exactly once");
  const none = await runBrowseTask("g", 1, deps({ callModel: async () => call("finish", { result: "ok", success: true }) }));
  assert.ok(none.startsWith("✅ ok") && none.includes("لم يُتحقق من الدليل"), "nothing observed: no challenge loop, but flagged: " + none);
});
await t("time budget stops cleanly; step cap; abort signal", async () => {
  let clock = 0; let k = 0;
  const r = await runBrowseTask("g", 1, deps({ now: () => clock, callModel: async () => { clock += 9000; return call("act", { action: "scroll_down" }); }, browserAction: async () => { k++; return "الرابط الحالي: https://p.com\nx"; } }), { budgetMs: 28000, minStepMs: 8000 });
  assert.ok(r.startsWith("⏳") && r.includes("ميزانية الوقت") && r.includes("https://p.com") && k >= 2 && k <= 3, r);
  let c = 0; const r2 = await runBrowseTask("g", 1, deps({ callModel: async () => { c++; return call("act", { action: "wait" }); }, browserAction: async () => "same" }), { maxSteps: 4, budgetMs: 1e9 }); assert.ok(r2.includes("الحد الأقصى للخطوات (4)") && c === 4);
  const ac = new AbortController(); let d = 0; const r3 = await runBrowseTask("g", 1, deps({ callModel: async () => { if (++d === 2) ac.abort(); return call("act", { action: "wait" }); } }), { signal: ac.signal, budgetMs: 1e9 });
  assert.ok(r3.includes("أُوقفت المهمة") && d === 2, r3);
});
await t("invalid action, unknown tool, tool exception, >3 parallel tool calls are survivable", async () => {
  const seq = [call("act", { action: "hack" }), call("nuke", {}), call("web_search", { query: "q" }), call("finish", { result: "تم", success: false })]; let i = 0; const seen = [];
  const r = await runBrowseTask("g", 1, deps({ callModel: async (m) => { seen.push(lastTool(m)); return seq[i++]; }, webSearch: async () => { throw new Error("ddg down"); } }));
  assert.equal(r, "❌ لم يتحقق الهدف: تم"); assert.ok(seen[1].includes("action غير صالح") && seen[2].includes("أداة غير معروفة") && seen[3].includes("ddg down"));
  let hist = null; await runBrowseTask("g", 1, deps({ callModel: async (m) => { hist = m; if (m.length > 3) return { content: "done" }; return { content: null, tool_calls: Array.from({ length: 5 }, (_, j) => ({ id: "t" + j, type: "function", function: { name: "act", arguments: JSON.stringify({ action: "wait" }) } })) }; } }));
  const asst = hist.find((x) => x.tool_calls); assert.equal(asst.tool_calls.length, 3); assert.equal(hist.filter((x) => x.role === "tool").length, 3, "every kept call has a tool answer");
});
await t("stuck detection injects a nudge after 3 identical results", async () => {
  let nudged = false;
  await runBrowseTask("g", 1, deps({ browserAction: async () => "same page", callModel: async (m) => { if (m.some((x) => x.role === "user" && x.content.startsWith("تنبيه"))) { nudged = true; return { content: "stop" }; } return call("act", { action: "scroll_down" }); } }), { budgetMs: 1e9, maxSteps: 10 });
  assert.ok(nudged);
});
await t("schema: 4 tools; finish has evidence; act enum has the new actions", () => {
  assert.deepEqual(BROWSE_SUB_TOOLS.map((x) => x.function.name), ["act", "read_url", "web_search", "finish"]);
  assert.ok("evidence" in BROWSE_SUB_TOOLS[3].function.parameters.properties);
  const en = BROWSE_SUB_TOOLS[0].function.parameters.properties.action.enum; for (const a of ["back", "close_tab", "select", "extract_links", "press_key"]) assert.ok(en.includes(a));
});
console.log(`\n${n} browse-agent test groups passed`);

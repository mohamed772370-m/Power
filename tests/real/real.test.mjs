import assert from "node:assert/strict";
import { start } from "./server.mjs"; import { launch, makeReal } from "./harness.mjs";
process.env.STEEL_API_KEY ??= "";
const { createBrowser } = await import("../../src/browser.ts");
const { srv, base } = await start(); const chrome = await launch();
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };
const items = (r) => r.split("--- العناصر")[1] ?? "";
const fresh = async () => (await makeReal(createBrowser, chrome)).b;
try {
  await t("SoM on a page with a cookie overlay (real Chromium): warns, lists accept button, hides covered links, then reveals everything", async () => {
    const b = await fresh(); const r = await b.browserAction(1, "goto", base + "/", "");
    assert.ok(r.includes("⚠️ تراكب") && r.includes("Accept all cookies"), "warns + lists the accept button");
    assert.ok(!items(r).includes("About us"), "covered link is NOT offered");
    const id = items(r).match(/\[(\d+)\][^\n]*Accept all cookies/)[1];
    const r2 = await b.browserAction(1, "click", id, "");
    assert.ok(!r2.includes("⚠️ تراكب"), "overlay cleared");
    for (const needle of ["About us → /about", "Menu (div onclick)", "Tab Reviews", "editable", "Search products", "Open help"]) assert.ok(items(r2).includes(needle), "missing: " + needle);
  });

  await t("div[onclick] click reveals hidden link", async () => {
    const b = await fresh(); let r = await b.browserAction(1, "goto", base + "/", "");
    r = await b.browserAction(1, "click", items(r).match(/\[(\d+)\][^\n]*Accept all/)[1], "");
    r = await b.browserAction(1, "click", items(r).match(/\[(\d+)\][^\n]*Menu \(div onclick\)/)[1], "");
    assert.ok(items(r).includes("Deep link"), items(r));
  });

  await t("NEW TAB: target=_blank is followed; close_tab returns", async () => {
    const b = await fresh(); let r = await b.browserAction(1, "goto", base + "/", "");
    r = await b.browserAction(1, "click", items(r).match(/\[(\d+)\][^\n]*Accept all/)[1], "");
    r = await b.browserAction(1, "click", items(r).match(/\[(\d+)\][^\n]*Open help/)[1], "");
    assert.ok(r.includes("🗂️ فُتح تبويب جديد") && r.includes("Help Popup") && r.includes("Call us at 123"), r.slice(0, 300));
    r = await b.browserAction(1, "close_tab", "", ""); assert.ok(r.includes("Home Page") && r.includes("عدتُ للتبويب السابق"), r.slice(0, 200));
    assert.ok((await b.browserAction(1, "close_tab", "", "")).startsWith("⚠️ لا يوجد تبويب سابق"));
  });

  await t("select by visible text / by value / unknown option lists choices", async () => {
    const b = await fresh(); let r = await b.browserAction(1, "goto", base + "/", "");
    r = await b.browserAction(1, "click", items(r).match(/\[(\d+)\][^\n]*Accept all/)[1], "");
    const sid = items(r).match(/\[(\d+)\][^\n]*<select/)[1];
    await b.browserAction(1, "select", sid, "Green");
    const pg = b.livePage(); assert.equal(await pg.$eval("#sel", (e) => e.value), "g");
    await b.browserAction(1, "select", sid, "b"); assert.equal(await pg.$eval("#sel", (e) => e.value), "b");
    const bad = await b.browserAction(1, "select", sid, "Purple"); assert.ok(bad.includes("غير موجود") && bad.includes("Red | Green | Blue"), bad);
  });

  await t("fill + press_enter submits a form; back returns", async () => {
    const b = await fresh(); let r = await b.browserAction(1, "goto", base + "/", "");
    r = await b.browserAction(1, "click", items(r).match(/\[(\d+)\][^\n]*Accept all/)[1], "");
    r = await b.browserAction(1, "fill", items(r).match(/\[(\d+)\][^\n]*Search products/)[1], "shoes");
    r = await b.browserAction(1, "press_enter", "", ""); assert.ok(r.includes("Search worked") && r.includes("q=shoes"), r.slice(0, 200));
    r = await b.browserAction(1, "back", "", ""); assert.ok(r.includes("Home Page"), r.slice(0, 120));
    assert.ok((await b.browserAction(1, "press_key", "", "Escape")).includes("الرابط الحالي"));
  });

  await t("viewport-first numbering + scroll info on a long page", async () => {
    const b = await fresh(); const r = await b.browserAction(1, "goto", base + "/many", "");
    assert.ok(/\[\d+\] <button[^>]*>: Top Action/.test(items(r)), "visible control present, no arrow");
    assert.ok(items(r).includes("↓") && r.includes("يوجد المزيد أسفل الصفحة"), "offscreen marked + scroll hint");
    const topId = Number(items(r).match(/\[(\d+)\] <button[^>]*>: Top Action/)[1]); assert.ok(topId <= 40, "visible items numbered first: " + topId);
    let last = r; for (let i = 0; i < 12; i++) last = await b.browserAction(1, "scroll_down", "", "");
    assert.ok(/\[\d+\] <button[^>]*>: Bottom Action/.test(items(last)) && last.includes("نهاية الصفحة"), last.split("--- العناصر")[0]);
  });

  await t("extract_links (with filter) is compact", async () => {
    const b = await fresh(); await b.browserAction(1, "goto", base + "/many", "");
    const all = await b.browserAction(1, "extract_links", "", ""); assert.ok(all.includes("الروابط (60 من 160)"));
    const f = await b.browserAction(1, "extract_links", "", "number 15"); assert.ok(f.includes("الروابط (11 من 160") && f.includes(`${base}/item/150`), f.slice(0, 200));
  });

  await t("REAL timing: goto + 2 clicks on a real page (old fixed sleeps alone would cost >= 6.5s)", async () => {
    const b = await fresh(); const s = Date.now();
    let r = await b.browserAction(1, "goto", base + "/", "");
    r = await b.browserAction(1, "click", items(r).match(/\[(\d+)\][^\n]*Accept all/)[1], "");
    await b.browserAction(1, "click", items(r).match(/\[(\d+)\][^\n]*Menu \(div onclick\)/)[1], "");
    const ms = Date.now() - s; console.log(`   3 real actions: ${ms}ms (old code: >= 1.5 + (2+1.5) + (2+1.5) = 8.5s of sleeps alone)`); assert.ok(ms < 6000);
  });
} finally { await chrome.close(); srv.close(); }
console.log(`\n${n} real-browser test groups passed`);

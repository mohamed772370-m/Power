
import assert from "node:assert/strict";
import { start } from "./real/server.mjs";
const { readUrl, isPrivateHost, htmlToText } = await import("../src/readurl.ts");
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };
const { srv, base } = await start(); const L = { allowPrivate: true };
try {
  await t("isPrivateHost: loopback/private/link-local/metadata/IPv6 blocked, public allowed", () => {
    for (const h of ["localhost", "127.0.0.1", "10.1.2.3", "192.168.1.5", "172.20.0.1", "169.254.169.254", "0.0.0.0", "[::1]", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "db.internal", "x.local", "100.64.0.1"]) assert.equal(isPrivateHost(h), true, h);
    for (const h of ["example.com", "8.8.8.8", "172.32.0.1", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPrivateHost(h), false, h);
  });
  await t("SSRF: default blocks localhost, metadata IP, hex/decimal IP forms, file://; redirect to private blocked", async () => {
    for (const u of [base + "/", "http://169.254.169.254/latest/meta-data", "http://2130706433/", "http://0x7f.0.0.1/", "file:///etc/passwd", "http://[::1]/"]) assert.ok((await readUrl(u)).startsWith("⚠️"), u);
    const r = await readUrl(base + "/redir-private", L); assert.ok(r.includes("مرفوض") || r.includes("تعذّر"), r);
    // public-looking first hop that redirects to a private host must be refused at the hop (simulated fetch)
    const fake = async (u) => String(u).includes("evil.com") ? { status: 302, ok: false, headers: new Headers({ location: "http://169.254.169.254/x" }) } : { status: 200, ok: true, headers: new Headers({ "content-type": "text/plain" }), text: async () => "SECRET" };
    assert.ok((await readUrl("https://evil.com/a", { fetchFn: fake })).includes("مرفوض"));
  });
  await t("article page: title, description, main text, entities, absolute links; junk removed", async () => {
    const r = await readUrl(base + "/article", L);
    assert.ok(r.includes("العنوان: Great Article") && r.includes("الوصف: An article about testing."), r.slice(0, 200));
    assert.ok(r.includes("First paragraph with relative link and & entity ع."), r.slice(0, 400));
    assert.ok(!r.includes("menu junk") && !r.includes("footer junk") && !r.includes("var junk") && !r.includes("color:red"));
    assert.ok(r.includes(`relative link → ${base}/rel/link`));
    assert.ok(r.includes("…(اقتُطع") === false || r.length < 8500);
  });
  await t("json / pdf / 404 / SPA hint / bad input", async () => {
    assert.ok((await readUrl(base + "/json", L)).includes('"a": 1'));
    assert.ok((await readUrl(base + "/pdf", L)).startsWith("📄"));
    assert.ok((await readUrl(base + "/nope", L)).includes("HTTP 404"));
    assert.ok((await readUrl(base + "/spa", L)).includes("تعتمد على JavaScript"));
    assert.ok((await readUrl("", L)).startsWith("⚠️")); assert.ok((await readUrl("http://", L)).startsWith("⚠️"));
  });
  await t("truncation + timeout handled", async () => {
    const big = { status: 200, ok: true, headers: new Headers({ "content-type": "text/html" }), text: async () => "<p>" + "word ".repeat(5000) + "</p>" };
    const r = await readUrl("https://x.com", { fetchFn: async () => big, maxChars: 500 }); assert.ok(r.includes("اقتُطع") && r.length < 900);
    const slow = (u, { signal }) => new Promise((_, rej) => signal.addEventListener("abort", () => rej(new Error("The operation was aborted due to timeout"))));
    assert.ok((await readUrl("https://slow.com", { fetchFn: slow, timeoutMs: 150 })).includes("انتهت المهلة"));
  });
  await t("speed: static read_url vs real browser goto on the same article (real Chromium)", async () => {
    const { launch, makeReal } = await import("./real/harness.mjs"); const { createBrowser } = await import("../src/browser.ts");
    const chrome = await launch(); try {
      const { b } = await makeReal(createBrowser, chrome); await b.ensureBrowser();
      let s = Date.now(); await b.browserAction(1, "goto", base + "/article", ""); const tb = Date.now() - s;
      s = Date.now(); await readUrl(base + "/article", L); const tr = Date.now() - s;
      console.log(`   browser goto: ${tb}ms | read_url: ${tr}ms (local server, no cloud-session creation; a remote Kernel/Steel session adds more)`);
      assert.ok(tr < tb);
    } finally { await chrome.close(); }
  });
} finally { srv.close(); }
console.log(`\n${n} readurl test groups passed`);

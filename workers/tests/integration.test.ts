import test from "node:test";
import assert from "node:assert/strict";
import { allowedActions, STATE_CHANGING_ACTIONS, BROWSER_ACTIONS } from "../src/browserutil.ts";
import { applyConfirmation, browseSystemPrompt, browseTools, elementSignature, initJobState, roundNonce, stepTool, type JobState } from "../src/agent.ts";
import { SessionDeadError, somItemLine } from "../src/browsercf.ts";

function fakeKv(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    _m: m,
  };
}
const fakeEnv = (kv: any) => ({ JOBS: kv }) as any;
const fakeTg = { sendMessage: async () => 0, editMessage: async () => {}, sendPhoto: async () => {} } as any;

function makeJob(perms: "read" | "interact" = "interact"): JobState {
  const st = initJobState(0, "مهمة تجريبية", "", 0, { origin: "internal", perms, jobId: "task-test-1" });
  st.plan = { subtasks: [{ id: "1", title: "فرع", goal: "ج" }] } as any;
  return st;
}
const actCall = (action: string, target = "3", value = "") => ({
  id: "tc-1", function: { name: "act", arguments: JSON.stringify({ action, target, value }) },
});

test("permission tiers: read excludes state-changing, interact includes all", () => {
  for (const a of STATE_CHANGING_ACTIONS) assert.ok(!allowedActions("read").includes(a));
  assert.deepEqual([...allowedActions("interact")], [...BROWSER_ACTIONS]);
  assert.ok(allowedActions("read").includes("goto"));
});

test("browseTools: interact adds request_confirmation and full enum; read does not", () => {
  const read = browseTools("read");
  const interact = browseTools("interact");
  assert.ok(!read.some((t: any) => t.function.name === "request_confirmation"));
  assert.ok(interact.some((t: any) => t.function.name === "request_confirmation"));
  const readEnum = read[0].function.parameters.properties.action.enum;
  const interactEnum = interact[0].function.parameters.properties.action.enum;
  for (const a of STATE_CHANGING_ACTIONS) { assert.ok(!readEnum.includes(a)); assert.ok(interactEnum.includes(a)); }
});

test("system prompt: interact tier adds the confirmation rule", () => {
  assert.ok(browseSystemPrompt("interact").includes("request_confirmation"));
  assert.ok(!browseSystemPrompt("read").includes("request_confirmation"));
});

test("applyConfirmation: no decision keeps the job paused", () => {
  const st = makeJob();
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "إرسال نموذج", toolCallId: "tc-9", intended: { action: "click", target: "7", value: "" }, nonce: "n-1", url: "", elementSig: "", at: Date.now() };
  assert.equal(applyConfirmation(st, null, null), null);
});

test("applyConfirmation: a stale-nonce decision cannot resume the job", () => {
  const st = makeJob();
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "إرسال نموذج", toolCallId: "tc-9", intended: { action: "click", target: "7", value: "" }, nonce: "n-1", url: "", elementSig: "", at: Date.now() };
  assert.equal(applyConfirmation(st, "approved", "n-OLD"), null);
  assert.equal(st.next, "await_confirm");
  assert.equal(st.approvedAction, null);
});

test("applyConfirmation: approval binds the exact intended action with ~10min expiry", () => {
  const st = makeJob();
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "إرسال نموذج", toolCallId: "tc-9", intended: { action: "click", target: "7", value: "" }, nonce: "n-1", url: "https://x.test/p", elementSig: "", at: Date.now() };
  const out = applyConfirmation(st, "approved", "n-1");
  assert.ok(out);
  assert.equal(out!.next, "llm");
  assert.equal(out!.pendingConfirm, null);
  assert.deepEqual({ action: out!.approvedAction!.action, target: out!.approvedAction!.target, value: out!.approvedAction!.value }, { action: "click", target: "7", value: "" });
  const ttl = out!.approvedAction!.expiresAt - Date.now();
  assert.ok(ttl > 9 * 60_000 && ttl <= 10 * 60_000 + 1000);
  const toolMsg = out!.messages.at(-1)!;
  assert.equal(toolMsg.role, "tool");
  assert.equal(toolMsg.tool_call_id, "tc-9");
  assert.equal(toolMsg.name, "request_confirmation");
});

test("applyConfirmation: rejection sets no approvedAction", () => {
  const st = makeJob();
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "نشر", toolCallId: "tc-9", intended: { action: "click", target: "2", value: "" }, nonce: "n-1", url: "", elementSig: "", at: Date.now() };
  const out = applyConfirmation(st, "rejected", "n-1")!;
  assert.equal(out.next, "llm");
  assert.equal(out.approvedAction, null);
});

test("ledger: replay against done returns recorded result without executing", async () => {
  const kv = fakeKv({ "act:task-test-1:tc-1": JSON.stringify({ state: "done", result: "تم النقر سابقاً" }) });
  const st = makeJob();
  st.approvedAction = { action: "click", target: "submit-btn", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 };
  st.pendingTools = [actCall("click", "submit-btn")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("تسليم مكرر"));
  assert.ok(String(toolMsg?.content).includes("تم النقر سابقاً"));
});

test("ledger: replay against bare intent is reported ambiguous, never claimed success", async () => {
  const kv = fakeKv({ "act:task-test-1:tc-1": JSON.stringify({ state: "intent", action: "click" }) });
  const st = makeJob();
  st.approvedAction = { action: "click", target: "submit-btn", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 };
  st.pendingTools = [actCall("click", "submit-btn")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("قد تكون نُفّذت"));
  assert.ok(!String(toolMsg?.content).includes("✅"));
});

test("read tier blocks state-changing action at dispatcher", async () => {
  const kv = fakeKv();
  const st = makeJob("read");
  st.pendingTools = [actCall("click")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("قراءة فقط"));
  assert.equal(kv._m.size, 0); // no ledger write for a blocked action
});

test("fail-closed: interact-tier state-changing action without approval does not execute and writes no ledger intent", async () => {
  const kv = fakeKv();
  const st = makeJob(); // interact tier, no approvedAction
  st.pendingTools = [actCall("click")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("request_confirmation"));
  assert.ok(String(toolMsg?.content).includes("لم تنفَّذ"));
  assert.equal(kv._m.size, 0);
});

test("fail-closed: mismatched target is blocked even with a valid approval for another element", async () => {
  const kv = fakeKv();
  const st = makeJob();
  st.approvedAction = { action: "click", target: "9", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 };
  st.pendingTools = [actCall("click", "3")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("لم تنفَّذ"));
  assert.equal(kv._m.size, 0);
  assert.ok(out.approvedAction); // not consumed by a mismatch
});

test("fail-closed: expired approval blocks", async () => {
  const kv = fakeKv();
  const st = makeJob();
  st.approvedAction = { action: "click", target: "3", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() - 1000, obsCount: 0 };
  st.pendingTools = [actCall("click")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("لم تنفَّذ"));
  assert.equal(out.approvedAction, null); // expired approval cleared
});

test("fail-closed: URL change after approval blocks (stale element identity)", async () => {
  const kv = fakeKv();
  const st = makeJob();
  st.approvedAction = { action: "click", target: "3", value: "", url: "https://x.test/a", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 };
  st.lastUrl = "https://x.test/b";
  st.pendingTools = [actCall("click")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("لم تنفَّذ"));
  assert.equal(kv._m.size, 0);
});

test("elementSignature: extracts the normalized line for the approved target", () => {
  const report = "الرابط الحالي: https://x.test/a\n[3] <button submit>: إرسال الطلب\n[7] <a>: تفاصيل";
  assert.equal(elementSignature(report, "3"), "<button submit>: إرسال الطلب");
  assert.equal(elementSignature(report, "[7]"), "<a>: تفاصيل");
  assert.equal(elementSignature(report, "99"), "");
});

test("R3: two decisions for one round - first applies, second no-ops", () => {
  const st = makeJob();
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "إرسال", toolCallId: "tc-9", intended: { action: "click", target: "7", value: "" }, nonce: "n-1", url: "", elementSig: "", at: Date.now() };
  const first = applyConfirmation(st, "approved", "n-1");
  assert.ok(first);
  assert.equal(first!.next, "llm");
  assert.ok(first!.approvedAction);
  // Second decision message for the same round: state is no longer awaiting -> no-op.
  const before = JSON.stringify(first);
  const second = applyConfirmation(first!, "rejected", "n-1");
  assert.equal(JSON.stringify(second), before);
});

// --- Review round 5 additions ---

test("N1: read tier excludes forward/reload (navigation class); back preserved as preexisting pilot surface", async () => {
  for (const a of ["forward", "reload"]) {
    assert.ok(!allowedActions("read").includes(a), `${a} must not be in the read tier`);
    assert.ok((STATE_CHANGING_ACTIONS as readonly string[]).includes(a), `${a} must be approval-gated`);
    assert.ok(allowedActions("interact").includes(a), `${a} stays available behind the interact-tier gate`);
  }
  // "back" predates the M8 port at read tier; preserved per main (round 5),
  // reviewer to confirm its navigation-class risk explicitly.
  assert.ok(allowedActions("read").includes("back"));
  // dispatcher blocks them at read tier like any other state-changing action
  const kv = fakeKv();
  const st = makeJob("read");
  st.pendingTools = [actCall("reload", "")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("قراءة فقط"));
  assert.equal(kv._m.size, 0);
});

test("N2: captured element signature with no live browser session fails closed (never executes on a blank page)", async () => {
  const kv = fakeKv();
  const st = makeJob(); // interact tier
  st.browser = null; // session lost between request and execution
  st.approvedAction = { action: "click", target: "3", value: "", url: "", elementSig: "(1,2) <button submit>: إرسال", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: st.obsCount ?? 0 };
  st.pendingTools = [actCall("click", "3")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("لم تنفَّذ"));
  assert.equal(out.approvedAction, null); // consumed/cleared: a fresh request_confirmation is required
  assert.equal(kv._m.size, 0); // no ledger intent written for a blocked action
});

test("N3b: elementSignature is pinned to the REAL markAndCapture line format (somItemLine)", async () => {
  const { somItemLine } = await import("../src/browsercf.ts");
  const items = [
    { id: 1, tag: "a", type: "", text: "الرئيسية", href: "https://x.test/" },
    { id: 3, pos: "(120,340)", tag: "button", type: "submit", text: "إرسال الطلب" },
    { id: 7, tag: "input", type: "checkbox", text: "أوافق على الشروط", checked: false },
    { id: 9, tag: "button", type: "button", text: "حذف", disabled: true },
  ];
  // Every produced line must carry the numeric prefix the parser depends on:
  for (const it of items) assert.ok(/^\[\d+\]/.test(somItemLine(it as any)), "report line lost its [n] prefix - parser would silently fail closed");
  // A report shaped exactly like markAndCapture's output (headers + lines):
  const report =
    "الرابط الحالي: https://x.test/a\nعنوان الصفحة: نموذج\nموضع التمرير: 0/0px\n\n" +
    "--- النص الظاهر في الصفحة ---\nنص الصفحة هنا\n\n" +
    "--- العناصر التفاعلية المرقمة (استخدم الرقم فقط في target عند النقر أو الكتابة؛ ↓/↑ = خارج الشاشة) ---\n" +
    items.map((it) => somItemLine(it as any)).join("\n");
  const sig3 = elementSignature(report, "3");
  assert.ok(sig3.length > 0, "signature must be non-empty for a real report line");
  assert.equal(sig3, somItemLine(items[1] as any).replace(/^\[3\]\s*/, "").replace(/\s+/g, " ").trim());
  assert.ok(sig3.includes("<button submit>") && sig3.includes("إرسال الطلب"));
  assert.ok(elementSignature(report, "7").includes("☐"));
  assert.ok(elementSignature(report, "9").includes("(معطّل)"));
  assert.equal(elementSignature(report, "42"), ""); // absent target -> no signature -> fail closed
});

test("N3a regression: a bare [n] marker line in the page-text section does not shadow the real element line", () => {
  const report =
    "الرابط الحالي: https://x.test/a\nعنوان الصفحة: ت\n\n--- النص الظاهر في الصفحة ---\nنص\nاضغط هنا\n[1]\n\n" +
    "--- العناصر التفاعلية المرقمة (استخدم الرقم فقط في target عند النقر أو الكتابة؛ ↓/↑ = خارج الشاشة) ---\n[1] <button submit>: اضغط هنا";
  assert.equal(elementSignature(report, "1"), "<button submit>: اضغط هنا");
});

test("F1b: replayed request_confirmation with the same toolCallId keeps the existing nonce (no new round)", async () => {
  const kv = fakeKv();
  const st = makeJob();
  const rcCall = { id: "tc-rc-1", function: { name: "request_confirmation", arguments: JSON.stringify({ summary: "s", action: "click", target: "3", value: "" }) } };
  st.pendingTools = [rcCall];
  const first = await stepTool(fakeEnv(kv), st, fakeTg);
  const nonce1 = first.pendingConfirm?.nonce;
  assert.ok(nonce1);
  assert.equal(first.next, "await_confirm");
  // queue redelivery replays the SAME tool call from a stale pre-pause read:
  const replayed = await stepTool(fakeEnv(kv), { ...first, pendingTools: [rcCall] } as JobState, fakeTg);
  assert.equal(replayed.pendingConfirm?.nonce, nonce1, "nonce must not rotate on a stale-state replay");
  assert.equal(replayed.next, "await_confirm");
  // a genuinely NEW request (different toolCallId) opens a new round:
  const rcCall2 = { id: "tc-rc-2", function: { name: "request_confirmation", arguments: JSON.stringify({ summary: "s2", action: "click", target: "4", value: "" }) } };
  const second = await stepTool(fakeEnv(kv), { ...first, pendingTools: [rcCall2] } as JobState, fakeTg);
  assert.notEqual(second.pendingConfirm?.nonce, nonce1);
});

test("F1b deterministic round identity: fresh toolCallId for the SAME intended action keeps the round; decisions/different actions start new ones", async () => {
  // the reviewer's true stale shape: stale snapshot reruns the LLM, which reissues
  // request_confirmation with a NEW toolCallId but the same intended action
  const kv = fakeKv();
  const st = makeJob();
  const mk = (id: string, target = "3") => ({ id, function: { name: "request_confirmation", arguments: JSON.stringify({ summary: "s", action: "click", target, value: "" }) } });
  st.pendingTools = [mk("tc-rc-1")];
  const first = await stepTool(fakeEnv(kv), st, fakeTg);
  const n1 = first.pendingConfirm!.nonce;
  st.pendingTools = [mk("tc-rc-NEW")]; // fresh call id, same round shape
  const replay = await stepTool(fakeEnv(kv), { ...first } as JobState, fakeTg);
  assert.equal(replay.pendingConfirm!.nonce, n1, "same round shape must regenerate the same nonce regardless of toolCallId");
  // different intended action -> different round
  st.pendingTools = [mk("tc-rc-3", "9")];
  const other = await stepTool(fakeEnv(kv), { ...first, pendingConfirm: null } as JobState, fakeTg);
  assert.notEqual(other.pendingConfirm!.nonce, n1);
  // applied decision -> the identical re-request is a NEW round
  const decided = applyConfirmation(first, "rejected", n1)!;
  decided.pendingTools = [mk("tc-rc-4")];
  const round2 = await stepTool(fakeEnv(kv), decided, fakeTg);
  assert.notEqual(round2.pendingConfirm!.nonce, n1, "a deliberate re-request after a decision is a distinct round");
});

test("roundNonce: deterministic, seq/target sensitive", async () => {
  const a = await roundNonce("j1", { action: "click", target: "3", value: "" }, "https://x/", 0);
  assert.equal(a, await roundNonce("j1", { action: "click", target: "3", value: "" }, "https://x/", 0));
  assert.notEqual(a, await roundNonce("j1", { action: "click", target: "3", value: "" }, "https://x/", 1));
  assert.notEqual(a, await roundNonce("j1", { action: "click", target: "4", value: "" }, "https://x/", 0));
  assert.notEqual(a, await roundNonce("j2", { action: "click", target: "3", value: "" }, "https://x/", 0));
});

test("dead browser session (second death) throws SessionDeadError out of stepTool, ledger stays intent", async () => {
  const kv = fakeKv();
  const env: any = { ...fakeEnv(kv), KERNEL_API_KEY: "k" };
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (u: any) => { calls.push(String(u)); return new Response("nf", { status: 404 }); }) as any;
  try {
    const st = makeJob();
    st.browser = { provider: "kernel", sessionId: "dead-1", cdpWsUrl: "", targets: [], recreated: true } as any;
    st.approvedAction = { action: "click", target: "7", value: "", url: "", elementSig: "sig-7", nonce: "n-1", expiresAt: Date.now() + 60000, obsCount: 0 };
    st.pendingTools = [actCall("click", "7")];
    await assert.rejects(stepTool(env, st, fakeTg), (e: any) => e instanceof SessionDeadError);
    // refusal to blindly re-execute: no ledger entry may reach "done"
    const recRaw = kv._m.get(`act:${st.jobId}:tc-1`);
    assert.ok(!recRaw || JSON.parse(recRaw).state !== "done");
    assert.ok(calls.some((u) => u.includes("/browsers/dead-1")), "liveness probe hit the kernel API");
  } finally { globalThis.fetch = realFetch; }
});

test("first dead-session probe recovers once; failure on the recovered session is a second death (SessionDeadError, no third session)", async () => {
  const kv = fakeKv();
  const env: any = { ...fakeEnv(kv), KERNEL_API_KEY: "k" };
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  let creates = 0;
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    calls.push(url);
    if (url.endsWith("/browsers/dead-2")) return new Response("nf", { status: 404 });
    if (url.endsWith("/browsers") && init?.method === "POST") {
      creates++;
      return new Response(JSON.stringify({ session_id: "fresh-1", cdp_ws_url: "ws://127.0.0.1:1/x" }), { status: 200 });
    }
    return new Response("x", { status: 500 });
  }) as any;
  try {
    const st = makeJob();
    st.browser = { provider: "kernel", sessionId: "dead-2", cdpWsUrl: "", targets: [] } as any;
    st.approvedAction = { action: "click", target: "7", value: "", url: "", elementSig: "sig-7", nonce: "n-1", expiresAt: Date.now() + 60000, obsCount: 0 };
    st.pendingTools = [actCall("click", "7")];
    // Probe recovers dead-2 -> fresh-1 (one recreate, ledgered). The recovered
    // session's CDP refuses every connection: that is the lineage's second death
    // and must propagate SessionDeadError (fail-closed), never a third session.
    await assert.rejects(stepTool(env, st, fakeTg), (e: any) => e instanceof SessionDeadError);
    assert.ok(calls.some((u) => u.includes("/browsers/dead-2")), "probe called");
    assert.equal(creates, 1, "exactly one recreate, no third session");
    // Recovery ledger was written BEFORE the recreate attempt (crash-safe bound).
    assert.equal(kv._m.get(`recreate:dead-2`), "1");
  } finally { globalThis.fetch = realFetch; }
});

test("recovery ledger blocks a recreate after a crash reset the in-memory flag (stale KV state, no third session)", async () => {
  const kv = fakeKv({ "recreate:dead-3": "1" }); // ledger entry from the crashed attempt
  const env: any = { ...fakeEnv(kv), KERNEL_API_KEY: "k" };
  const realFetch = globalThis.fetch;
  let creates = 0;
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    if (url.endsWith("/browsers/dead-3")) return new Response("nf", { status: 404 });
    if (url.endsWith("/browsers") && init?.method === "POST") { creates++; return new Response(JSON.stringify({ session_id: "fresh-9", cdp_ws_url: "ws://127.0.0.1:1/y" }), { status: 200 }); }
    return new Response("x", { status: 500 });
  }) as any;
  try {
    const st = makeJob();
    // Redelivery after a crash: state was never re-saved, so recreated is false -
    // only the KV ledger remembers the lineage already consumed its recovery.
    st.browser = { provider: "kernel", sessionId: "dead-3", cdpWsUrl: "", targets: [] } as any;
    st.approvedAction = { action: "click", target: "7", value: "", url: "", elementSig: "sig-7", nonce: "n-1", expiresAt: Date.now() + 60000, obsCount: 0 };
    st.pendingTools = [actCall("click", "7")];
    await assert.rejects(stepTool(env, st, fakeTg), (e: any) => e instanceof SessionDeadError);
    assert.equal(creates, 0, "ledger blocked the second recreate");
  } finally { globalThis.fetch = realFetch; }
});

// --- Review round 7: approve -> session death -> recreate -> signature mismatch -> fail closed ---

// In-process fake at the WebSocket boundary: the REAL Cdp client (id matching,
// pending map, session routing) runs; no network, no hand-rolled server.
class FakeCdpWs {
  static instances: FakeCdpWs[] = [];
  static sentMethods: string[] = [];
  static shotCount = 0;
  private listeners: Record<string, Array<(ev: any) => void>> = {};
  constructor(public url: string) {
    FakeCdpWs.instances.push(this);
    queueMicrotask(() => (this.listeners["open"] ?? []).forEach((f) => f({})));
  }
  addEventListener(type: string, f: (ev: any) => void) { (this.listeners[type] ??= []).push(f); }
  removeEventListener() {}
  send(data: string) {
    const msg = JSON.parse(data);
    FakeCdpWs.sentMethods.push(String(msg.method));
    const expr = String(msg.params?.expression ?? "");
    let result: any = {};
    if (msg.method === "Target.attachToTarget") result = { sessionId: "S-fake-1" };
    else if (msg.method === "Target.createTarget") result = { targetId: "T-fake-1" };
    else if (msg.method === "Target.getTargets") result = { targetInfos: [] };
    else if (msg.method === "Page.captureScreenshot") {
      FakeCdpWs.shotCount += 1;
      result = { data: FakeCdpWs.shotCount === 1 ? "RklSU1Q=" : "U0VDT05E" }; // "FIRST" / "SECOND"
    }
    else if (msg.method === "Runtime.evaluate") {
      let value: any = null;
      if (expr === "location.href") value = "https://t.test/";
      else if (expr === "document.title") value = "صفحة اختبار";
      else if (expr.length > 200) value = { items: [{ id: 7, tag: "button", type: "", text: "DIFFERENT BUTTON", pos: "" }], docH: 1000, vh: 800, scrollY: 0, blocked: 0 }; // SOM script (contains "innerText" in its source): check length FIRST
      else if (expr.includes("innerText")) value = "نص الصفحة الاختبارية الطويل نسبياً ليتجاوز حد إعادة الفحص في مسار الملاحظة أثناء الاختبار.";
      result = { result: { type: typeof value, value } };
    }
    queueMicrotask(() => (this.listeners["message"] ?? []).forEach((f) => f({ data: JSON.stringify({ id: msg.id, result }) })));
  }
  close(_code?: number) { (this.listeners["close"] ?? []).forEach((f) => f({})); }
}

test("approved execution after a session death + recreate: fresh-observe signature mismatch fails CLOSED (no execution, no artifact, approval consumed)", async () => {
  const kv = fakeKv();
  const env: any = { ...fakeEnv(kv), KERNEL_API_KEY: "k" };
  const realFetch = globalThis.fetch;
  const realWs = globalThis.WebSocket;
  let creates = 0;
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    if (url.endsWith("/browsers/dead-4")) return new Response("nf", { status: 404 }); // probe + destroy of the dead session
    if (url.endsWith("/browsers/fresh-4")) return new Response("{}", { status: 200 });
    if (url.endsWith("/browsers") && init?.method === "POST") { creates++; return new Response(JSON.stringify({ session_id: "fresh-4", cdp_ws_url: "ws://fake/cdp" }), { status: 200 }); }
    return new Response("x", { status: 500 });
  }) as any;
  (globalThis as any).WebSocket = FakeCdpWs;
  FakeCdpWs.sentMethods = [];
  try {
    const st = makeJob();
    st.lastUrl = "https://t.test/";
    st.obsCount = 0;
    st.browser = { provider: "kernel", sessionId: "dead-4", cdpWsUrl: "", targets: [] } as any;
    st.approvedAction = { action: "click", target: "7", value: "", url: "https://t.test/", elementSig: "sig-7", nonce: "n-1", expiresAt: Date.now() + 60000, obsCount: 0 } as any;
    st.pendingTools = [actCall("click", "7")];
    const seqBefore = st.confirmSeq;
    const st2 = await stepTool(env, st, fakeTg);
    // The recreated session's page does not carry the approved element identity:
    // element 7 is "DIFFERENT BUTTON", not whatever produced "sig-7".
    const toolOut = st2.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content)).join("\n");
    assert.ok(toolOut.includes("لم تنفَّذ"), `expected fail-closed refusal, got: ${toolOut.slice(0, 160)}`);
    // The refusal must come from a REAL nonempty-signature mismatch, not an
    // empty-signature rejection: the recreated page serves element 7 through
    // the (fixed) fake SOM path, and its computed signature must be nonempty
    // and differ from the approved one.
    const freshSig = elementSignature("--- العناصر التفاعلية المرقمة ---\n" + somItemLine({ id: 7, tag: "button", type: "", text: "DIFFERENT BUTTON", pos: "" }), "7");
    assert.ok(freshSig.length > 0, "fresh-observe signature is nonempty (fake SOM serves element 7)");
    assert.notEqual(freshSig, "sig-7", "fresh signature genuinely differs from the approved one");
    assert.ok(FakeCdpWs.sentMethods.includes("Runtime.evaluate"), "a real observe ran against the recreated session");
    assert.equal(st.approvedAction, null, "approval consumed/voided, not left armed");
    assert.equal(st.confirmSeq, seqBefore, "no confirmation round consumed by a failed verify");
    assert.equal(creates, 1, "exactly one lineage recreate");
    assert.ok(!FakeCdpWs.sentMethods.some((m) => m.startsWith("Input.")), "NO input dispatched - nothing was executed");
    assert.ok(!FakeCdpWs.sentMethods.includes("Page.captureScreenshot"), "no artifact captured for a non-execution");
    assert.ok(![...kv._m.keys()].some((k) => k.startsWith("artifact:")), "no artifact stored");
    const recRaw = kv._m.get(`act:${st.jobId}:tc-1`);
    assert.ok(!recRaw || JSON.parse(recRaw).state !== "done", "no done ledger entry for the refused action");
  } finally {
    globalThis.fetch = realFetch;
    (globalThis as any).WebSocket = realWs;
  }
});

test("durable stop guard: an approved action does not execute after cancel when the stop signal is visible (best-effort, KV-cache-bounded)", async () => {
  const kv = fakeKv({ "stopped:task-test-1": "1" });
  const st = makeJob();
  st.approvedAction = { action: "click", target: "submit-btn", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 };
  st.pendingTools = [actCall("click", "submit-btn")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("STOP"), `expected STOP refusal, got: ${String(toolMsg?.content).slice(0, 160)}`);
  assert.ok(String(toolMsg?.content).includes("cancelled"));
  assert.ok(!kv._m.has("act:task-test-1:tc-1"), "no ledger intent: execution never started");
  assert.equal(st.approvedAction, null, "approval consumed, not re-armed");
});

test("artifact double-shot: the recorded artifact is the LATER shot (run9 timing fix)", async () => {
  const kv = fakeKv();
  const env: any = { ...fakeEnv(kv), KERNEL_API_KEY: "k" };
  const realFetch = globalThis.fetch;
  const realWs = globalThis.WebSocket;
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    if (url.endsWith("/browsers/live-1")) return new Response("{}", { status: 200 }); // liveness probe: session alive
    return new Response("x", { status: 500 });
  }) as any;
  (globalThis as any).WebSocket = FakeCdpWs;
  FakeCdpWs.sentMethods = [];
  FakeCdpWs.shotCount = 0;
  try {
    const obsShape: any = { items: [{ id: 7, tag: "button", type: "", text: "DIFFERENT BUTTON", pos: "" }], docH: 1000, vh: 800, scrollY: 0, blocked: 0 };
    const st = makeJob();
    st.lastUrl = "https://t.test/";
    st.obsCount = 0;
    st.browser = { provider: "kernel", sessionId: "live-1", cdpWsUrl: "ws://fake/cdp", targets: [] } as any;
    st.approvedAction = { action: "click", target: "7", value: "", url: "https://t.test/", elementSig: elementSignature("--- العناصر التفاعلية المرقمة ---\n" + somItemLine(obsShape.items[0]), "7"), nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 } as any;
    st.pendingTools = [actCall("click", "7")];
    const out = await stepTool(env, st, fakeTg);
    const toolOut = out.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content)).join("\n");
    assert.ok(!toolOut.includes("لم تنفَّذ"), `execution should proceed, got: ${toolOut.slice(0, 200)}`);
    assert.equal(FakeCdpWs.shotCount, 2, "markAndCapture shot + double-shot");
    assert.equal(kv._m.get("artifact:task-test-1"), "U0VDT05E", "the LATER shot is the recorded artifact");
  } finally {
    globalThis.fetch = realFetch;
    (globalThis as any).WebSocket = realWs;
  }
});

test("stop-signal lifecycle: marker expired but the 24h stopped RESULT record still blocks execution", async () => {
  // The stopped: marker and the stopped result record have the same 24h TTL;
  // this pins the fallback itself: even with the marker absent, the result
  // record alone must block an approved execution.
  const kv = fakeKv({ "result:task-test-1": JSON.stringify({ status: "stopped", text: "أُلغيت", at: 1 }) });
  const st = makeJob();
  st.approvedAction = { action: "click", target: "submit-btn", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 };
  st.pendingTools = [actCall("click", "submit-btn")];
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("STOP"), `expected STOP refusal via result record, got: ${String(toolMsg?.content).slice(0, 160)}`);
  assert.ok(!kv._m.has("act:task-test-1:tc-1"), "no ledger intent: execution never started");
});

test("stale-generation replay: an already-executed approved action replays the ledger, never re-executes", async () => {
  // A stale snapshot can carry an UNCONSUMED approval for an action whose
  // ledger already says done. The ledger must answer with the recorded result
  // and no new execution (no ledger rewrite, no browser call).
  const kv = fakeKv({ "act:task-test-1:tc-1": JSON.stringify({ state: "done", result: "تم النقر سابقاً" }) });
  const st = makeJob();
  st.approvedAction = { action: "click", target: "submit-btn", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 };
  st.pendingTools = [actCall("click", "submit-btn")];
  const before = kv._m.get("act:task-test-1:tc-1");
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("تسليم مكرر"), `expected ledger replay, got: ${String(toolMsg?.content).slice(0, 160)}`);
  assert.equal(kv._m.get("act:task-test-1:tc-1"), before, "ledger record untouched by the replay");
});

test("actround: stale next=llm replay with a FRESH tool-call id is caught by the round marker, never re-executes", async () => {
  // Reviewer finding (real double-execution bug): the per-call ledger keys on the
  // model's tool-call id; a stale generation replayed at next=llm re-issues the SAME
  // approved action under a FRESH id, which missed the ledger and double-executed.
  const kv = fakeKv({
    "act:task-test-1:tc-1": JSON.stringify({ state: "done", result: "تم النقر سابقاً" }),
    "actround:task-test-1:n-1": JSON.stringify({ state: "done", result: "تم النقر سابقاً" }),
  });
  const st = makeJob();
  st.approvedAction = { action: "click", target: "submit-btn", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 };
  st.pendingTools = [{ id: "tc-FRESH", function: { name: "act", arguments: JSON.stringify({ action: "click", target: "submit-btn", value: "" }) } }] as any;
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("تسليم مكرر"), `expected round replay, got: ${String(toolMsg?.content).slice(0, 160)}`);
  assert.ok(String(toolMsg?.content).includes("تم النقر سابقاً"), "recorded result surfaced");
  assert.ok(!kv._m.has("act:task-test-1:tc-FRESH"), "no per-call intent for the fresh id: execution never started");
  assert.equal(JSON.parse(kv._m.get("actround:task-test-1:n-1")!).state, "done", "round marker untouched by the replay");
  assert.equal(st.approvedAction, null, "approval consumed by the replay, not re-armed");
});

test("actround: stale replay against a round intent is reported ambiguous, never re-executes", async () => {
  const kv = fakeKv({ "actround:task-test-1:n-1": JSON.stringify({ state: "intent", action: "click" }) });
  const st = makeJob();
  st.approvedAction = { action: "click", target: "submit-btn", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 };
  st.pendingTools = [{ id: "tc-FRESH", function: { name: "act", arguments: JSON.stringify({ action: "click", target: "submit-btn", value: "" }) } }] as any;
  const out = await stepTool(fakeEnv(kv), st, fakeTg);
  const toolMsg = out.messages.find((m: any) => m.role === "tool");
  assert.ok(String(toolMsg?.content).includes("قد تكون نُفّذت"), `expected ambiguous refusal, got: ${String(toolMsg?.content).slice(0, 160)}`);
  assert.ok(!String(toolMsg?.content).includes("✅"), "never claimed success");
  assert.ok(!kv._m.has("act:task-test-1:tc-FRESH"), "no per-call intent: execution never started");
  assert.equal(st.approvedAction, null, "approval consumed, not re-armed");
});

test("actround: first execution writes round intent+done alongside the per-call ledger", async () => {
  const kv = fakeKv();
  const env: any = { ...fakeEnv(kv), KERNEL_API_KEY: "k" };
  const realFetch = globalThis.fetch;
  const realWs = globalThis.WebSocket;
  globalThis.fetch = (async (u: any) => {
    const url = String(u);
    if (url.endsWith("/browsers/live-1")) return new Response("{}", { status: 200 });
    return new Response("x", { status: 500 });
  }) as any;
  (globalThis as any).WebSocket = FakeCdpWs;
  FakeCdpWs.sentMethods = [];
  FakeCdpWs.shotCount = 0;
  try {
    const obsShape: any = { items: [{ id: 7, tag: "button", type: "", text: "DIFFERENT BUTTON", pos: "" }], docH: 1000, vh: 800, scrollY: 0, blocked: 0 };
    const st = makeJob();
    st.lastUrl = "https://t.test/";
    st.obsCount = 0;
    st.browser = { provider: "kernel", sessionId: "live-1", cdpWsUrl: "ws://fake/cdp", targets: [] } as any;
    st.approvedAction = { action: "click", target: "7", value: "", url: "https://t.test/", elementSig: elementSignature("--- العناصر التفاعلية المرقمة ---\n" + somItemLine(obsShape.items[0]), "7"), nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 } as any;
    st.pendingTools = [actCall("click", "7")];
    const out = await stepTool(env, st, fakeTg);
    const toolOut = out.messages.filter((m: any) => m.role === "tool").map((m: any) => String(m.content)).join("\n");
    assert.ok(!toolOut.includes("لم تنفَّذ"), `execution should proceed, got: ${toolOut.slice(0, 200)}`);
    assert.equal(JSON.parse(kv._m.get("act:task-test-1:tc-1")!).state, "done", "per-call ledger done");
    assert.equal(JSON.parse(kv._m.get("actround:task-test-1:n-1")!).state, "done", "round marker done");
    assert.ok(JSON.parse(kv._m.get("actround:task-test-1:n-1")!).result, "round marker records the result");
  } finally {
    globalThis.fetch = realFetch;
    (globalThis as any).WebSocket = realWs;
  }
});

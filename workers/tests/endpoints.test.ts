import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { applyConfirmation, initJobState, JOB_TIMEOUT_MS } from "../src/agent.ts";

function fakeKv(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    get: async (k: string) => m.get(k) ?? null,
    put: async (k: string, v: string) => { m.set(k, v); },
    delete: async (k: string) => { m.delete(k); },
    _m: m,
  };
}
function env(kv: any, secret = "s3cret") {
  const sent: any[] = [];
  return {
    JOBS: kv, INTERNAL_TASK_SECRET: secret, WEBHOOK_SECRET: "wh",
    TELEGRAM_BOT_TOKEN: "t", NVIDIA_API_KEY: "n", ADMIN_TELEGRAM_ID: "1",
    JOBS_QUEUE: { send: async (m: any) => { sent.push(m); } },
    _sent: sent,
  } as any;
}
const post = (path: string, body: any, key?: string) =>
  new Request(`https://w.test${path}`, { method: "POST", body: JSON.stringify(body), headers: key ? { "x-internal-key": key, "content-type": "application/json" } : { "content-type": "application/json" } });

test("endpoints: all four reject a missing/wrong secret with 403", async () => {
  const kv = fakeKv();
  for (const req of [
    post("/task", { task: "x" }), post("/task", { task: "x" }, "wrong"),
    new Request("https://w.test/task-result?id=j1"),
    new Request("https://w.test/task-artifact?id=j1"),
    post("/task-confirm", { id: "j1", approve: true }, "wrong"),
    post("/task-cancel", { id: "j1" }),
  ]) {
    const res = await worker.fetch(req, env(kv));
    assert.equal(res.status, 403, `${req.method} ${new URL(req.url).pathname}`);
  }
});

test("endpoints: /task starts a job, /task-result reports running", async () => {
  const kv = fakeKv();
  const res = await worker.fetch(post("/task", { task: "مهمة" }, "s3cret"), env(kv));
  assert.equal(res.status, 200);
  const { job_id, status } = await res.json() as any;
  assert.ok(job_id.startsWith("task-"));
  assert.equal(status, "running");
  const r2 = await worker.fetch(new Request(`https://w.test/task-result?id=${job_id}`, { headers: { "x-internal-key": "s3cret" } }), env(kv));
  assert.equal((await r2.json() as any).status, "running");
});

test("endpoints: confirm validates + queues the decision; application is queue-serialized (R3)", async () => {
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "s", toolCallId: "tc", intended: { action: "click", target: "3", value: "" }, nonce: "n-1", url: "", at: Date.now() };
  const kv = fakeKv({ "state:j1": JSON.stringify(st) });
  const e = env(kv); // one env: the decision store must persist across calls
  // wrong nonce -> 409, no decision written
  const bad = await worker.fetch(post("/task-confirm", { id: "j1", approve: true, nonce: "n-OLD" }, "s3cret"), e);
  assert.equal(bad.status, 409);
  assert.equal(await kv.get("confirm:j1"), null);
  // right nonce -> 200, decision queued on the job's serialized queue
  const ok = await worker.fetch(post("/task-confirm", { id: "j1", approve: true, nonce: "n-1" }, "s3cret"), e);
  assert.equal(ok.status, 200);
  assert.deepEqual(e._sent.at(-1), { jobId: "j1", decision: "approved", nonce: "n-1" });
  // no KV decision record exists - the decision lives only in the message (R3)
  assert.equal(await kv.get("confirm:j1"), null);
});

test("endpoints: stale-snapshot confirm - the fresh confirm:<id> key accepts the decision once when state: lacks pendingConfirm", async () => {
  // The d899a9 409 race (2026-10-24): /task-confirm can read a pre-await state:
  // snapshot; the per-task await key written at pause is the authority here.
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j3" });
  st.next = "await_confirm"; // the stale snapshot has no pendingConfirm yet
  const kv = fakeKv({
    "state:j3": JSON.stringify(st),
    "confirm:j3": JSON.stringify({ nonce: "n-3", at: Date.now() }),
  });
  const e = env(kv);
  const ok = await worker.fetch(post("/task-confirm", { id: "j3", approve: true, nonce: "n-3" }, "s3cret"), e);
  assert.equal(ok.status, 200);
  assert.deepEqual(e._sent.at(-1), { jobId: "j3", decision: "approved", nonce: "n-3" });
  assert.equal(await kv.get("confirm:j3"), null, "the fallback consumed the await key");
  const replay = await worker.fetch(post("/task-confirm", { id: "j3", approve: true, nonce: "n-3" }, "s3cret"), e);
  assert.equal(replay.status, 409, "a replayed decision after consumption still 409s");
});

test("endpoints: cancel-mid-await stops the task and a late confirm is refused", async () => {
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j2" });
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "s", toolCallId: "tc", intended: { action: "click", target: "3", value: "" }, nonce: "n-2", url: "", at: Date.now() };
  const kv = fakeKv({ "state:j2": JSON.stringify(st) });
  const c = await worker.fetch(post("/task-cancel", { id: "j2" }, "s3cret"), env(kv));
  assert.equal(c.status, 200);
  assert.ok(String(await kv.get("result:j2")).includes("stopped"));
  const late = await worker.fetch(post("/task-confirm", { id: "j2", approve: true, nonce: "n-2" }, "s3cret"), env(kv));
  assert.equal(late.status, 409);
  assert.ok(String((await late.json() as any).error).includes("cancelled"));
});

test("endpoints: confirm on expired/unknown state 404s honestly", async () => {
  const kv = fakeKv();
  const res = await worker.fetch(post("/task-confirm", { id: "ghost", approve: true, nonce: "n" }, "s3cret"), env(kv));
  assert.equal(res.status, 404);
  assert.ok(String((await res.json() as any).error).includes("expired"));
});

// --- Review round 5: runUnits-level decision application from a queue message body (N3d) ---

function qMsg(body: any) { const m: any = { body, acks: 0, retries: 0, ack() { m.acks++; }, retry() { m.retries++; } }; return m; }
const batch = (messages: any[]) => ({ queue: "web-agent-jobs", messages }) as any;

function pausedState(nonce: string) {
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  st.plan = { subtasks: [{ id: "1", title: "فرع", goal: "ج" }] } as any;
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "s", toolCallId: "tc", intended: { action: "click", target: "3", value: "" }, nonce, url: "", elementSig: "", at: Date.now() };
  return st;
}

// Stub the LLM call so a resumed job can run its unit loop to completion offline.
function stubLlm() {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    if (String(url).includes("integrate.api.nvidia.com")) {
      calls++;
      return Response.json({ choices: [{ message: { role: "assistant", content: "تمت المتابعة بعد قرار المالك." } }] });
    }
    throw new Error(`offline test stub: ${String(url).slice(0, 80)}`);
  }) as any;
  return { restore: () => { globalThis.fetch = real; }, calls: () => calls };
}

test("runUnits: a queue message without a decision leaves the job paused (no resume, no re-enqueue)", async () => {
  const kv = fakeKv({ "state:j1": JSON.stringify(pausedState("n-1")) });
  const e = env(kv);
  const llm = stubLlm();
  const m = qMsg({ jobId: "j1" });
  try { await worker.queue(batch([m]), e); } finally { llm.restore(); }
  assert.equal(m.acks, 1);
  const after = JSON.parse((await kv.get("state:j1"))!);
  assert.equal(after.next, "await_confirm");
  assert.ok(after.pendingConfirm);
  assert.equal(llm.calls(), 0); // no work units ran
  assert.equal(e._sent.length, 0); // no self re-enqueue while paused
});

test("runUnits: a stale-nonce decision in the message body is discarded; job stays paused", async () => {
  const kv = fakeKv({ "state:j1": JSON.stringify(pausedState("n-1")) });
  const e = env(kv);
  const llm = stubLlm();
  const m = qMsg({ jobId: "j1", decision: "approved", nonce: "n-OLD" });
  try { await worker.queue(batch([m]), e); } finally { llm.restore(); }
  assert.equal(m.acks, 1);
  const after = JSON.parse((await kv.get("state:j1"))!);
  assert.equal(after.next, "await_confirm");
  assert.ok(after.pendingConfirm);
  assert.equal(llm.calls(), 0);
  assert.equal(e._sent.length, 0);
});

test("runUnits: a nonce-matching decision in the message body resumes the job and runs it to completion", async () => {
  const kv = fakeKv({ "state:j1": JSON.stringify(pausedState("n-1")) });
  const e = env(kv);
  const llm = stubLlm();
  const m = qMsg({ jobId: "j1", decision: "approved", nonce: "n-1" });
  try { await worker.queue(batch([m]), e); } finally { llm.restore(); }
  assert.equal(m.acks, 1);
  assert.ok(llm.calls() > 0, "resumed job must run its unit loop (LLM called)");
  assert.equal(await kv.get("state:j1"), null, "completed job state is cleaned up");
  const res = JSON.parse((await kv.get("result:j1"))!);
  assert.equal(res.status, "done", `job completed after decision, got: ${JSON.stringify(res).slice(0, 120)}`);
});

test("F1a: the awaiting_confirmation result marker carries the nonce (pull fallback can answer)", async () => {
  // drive a job into the pause inside runUnits via a stubbed LLM that calls request_confirmation
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  st.plan = { subtasks: [{ id: "1", title: "فرع", goal: "ج" }] } as any;
  const kv = fakeKv({ "state:j1": JSON.stringify(st) });
  const e = env(kv);
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("integrate.api.nvidia.com")) {
      return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "tc-rc-9", function: { name: "request_confirmation", arguments: JSON.stringify({ summary: "اختبار", action: "click", target: "3", value: "" }) } }] } }] });
    }
    throw new Error("offline test stub");
  }) as any;
  const m = qMsg({ jobId: "j1" });
  try { await worker.queue(batch([m]), e); } finally { globalThis.fetch = real; }
  assert.equal(m.acks, 1);
  const marker = JSON.parse((await kv.get("result:j1"))!);
  assert.equal(marker.status, "awaiting_confirmation");
  assert.ok(marker.nonce, "marker must carry the round nonce (F1a)");
  // and /task-result serves that nonce from the marker
  const res = await worker.fetch(new Request("https://w.test/task-result?id=j1", { headers: { "x-internal-key": "s3cret" } }), e);
  const body = await res.json() as any;
  assert.equal(body.status, "awaiting_confirmation");
  assert.equal(body.nonce, marker.nonce);
});

test("F1b runUnits: TRUE stale snapshot (next=llm, pendingConfirm null) re-pauses with the SAME nonce; decided re-request differs", async () => {
  const mkState = () => {
    const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
    st.plan = { subtasks: [{ id: "1", title: "فرع", goal: "ج" }] } as any;
    st.next = "llm"; // pre-pause snapshot shape: LLM about to run, no pendingConfirm
    return JSON.stringify(st);
  };
  const kv = fakeKv({ "state:j1": mkState() });
  const e = env(kv);
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: any) => {
    if (String(url).includes("integrate.api.nvidia.com")) {
      // stale LLM reissues the SAME intended action under a FRESH call id every time
      return Response.json({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-" + Math.random().toString(36).slice(2), function: { name: "request_confirmation", arguments: JSON.stringify({ summary: "اختبار", action: "click", target: "3", value: "" }) } }] } }] });
    }
    throw new Error("offline test stub");
  }) as any;
  try {
    await worker.queue(batch([qMsg({ jobId: "j1" })]), e); // pass 1: pauses
    const n1 = JSON.parse((await kv.get("result:j1"))!).nonce;
    assert.ok(n1);
    // true stale redelivery: KV serves the PRE-PAUSE snapshot again
    await kv.put("state:j1", mkState());
    await worker.queue(batch([qMsg({ jobId: "j1" })]), e); // pass 2: re-pauses
    const n2 = JSON.parse((await kv.get("result:j1"))!).nonce;
    assert.equal(n2, n1, "stale redelivery must regenerate the same round nonce (same event_id -> val dedupes)");
    // owner approves the round; then the model deliberately re-requests the same action
    await kv.put("state:j1", mkState()); // pre-pause snapshot again
    await worker.queue(batch([qMsg({ jobId: "j1" })]), e);
    const st = JSON.parse((await kv.get("state:j1"))!);
    const resumed = applyConfirmation(st, "approved", n1)!;
    resumed.pendingTools = [{ id: "call-x", function: { name: "request_confirmation", arguments: JSON.stringify({ summary: "اختبار", action: "click", target: "3", value: "" }) } }] as any;
    resumed.next = "tool";
    await kv.put("state:j1", JSON.stringify(resumed));
    await worker.queue(batch([qMsg({ jobId: "j1" })]), e);
    const n3 = JSON.parse((await kv.get("result:j1"))!).nonce;
    assert.notEqual(n3, n1, "a re-request after an applied decision is a new round");
  } finally { globalThis.fetch = real; }
});

test("endpoints: /task-artifact serves the stored execution jpeg behind the secret", async () => {
  const kv = fakeKv();
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9]);
  await kv.put("artifact:j1", btoa(String.fromCharCode(...jpeg)));
  const res = await worker.fetch(new Request("https://w.test/task-artifact?id=j1", { headers: { "x-internal-key": "s3cret" } }), env(kv));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  const got = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...got], [...jpeg]);
  const missing = await worker.fetch(new Request("https://w.test/task-artifact?id=nope", { headers: { "x-internal-key": "s3cret" } }), env(kv));
  assert.equal(missing.status, 404);
});

// --- Review round 6: runUnits-level budget terminalization + second-death terminal callback ---

test("runUnits: a job over its wall-clock budget terminalizes AT DELIVERY (no llm unit needed), state cleaned", async () => {
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j-budget" });
  st.next = "llm"; // would normally call the LLM - the delivery-level budget must fire first
  st.startedAt = Date.now() - JOB_TIMEOUT_MS - 60_000; // one minute past the job wall-clock budget
  const kv = fakeKv({ "state:j-budget": JSON.stringify(st) });
  const e = env(kv);
  const llm = stubLlm();
  const m = qMsg({ jobId: "j-budget" });
  try { await worker.queue(batch([m]), e); } finally { llm.restore(); }
  assert.equal(m.acks, 1);
  assert.equal(llm.calls(), 0, "budget fired before any unit ran");
  const res = JSON.parse((await kv.get("result:j-budget"))!);
  assert.equal(res.status, "done");
  assert.ok(res.text.startsWith("⏳"), "budget terminal text");
  assert.equal(await kv.get("state:j-budget"), null, "state cleaned at terminal");
  assert.equal(e._sent.length, 0, "no re-enqueue after terminalization");
});

test("runUnits: a second browser death terminalizes with a failed result + owner callback; a late confirm is then rejected", async () => {
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j-dead" });
  st.plan = { subtasks: [{ id: "1", title: "فرع", goal: "ج" }] } as any; // otherwise the first unit is stepPlan
  st.callbackChatId = 4242; // notifyVal skips jobs without a callback chat
  st.next = "tool";
  st.browser = { provider: "kernel", sessionId: "dead-9", cdpWsUrl: "", targets: [], recreated: true } as any;
  st.approvedAction = { action: "click", target: "7", value: "", url: "", elementSig: "sig-7", nonce: "n-1", expiresAt: Date.now() + 60000, obsCount: 0 } as any;
  st.pendingTools = [{ id: "tc-1", function: { name: "act", arguments: JSON.stringify({ action: "click", target: "7", value: "" }) } }] as any;
  const kv = fakeKv({ "state:j-dead": JSON.stringify(st) });
  const e = env(kv);
  e.KERNEL_API_KEY = "k";
  e.VAL_CALLBACK_URL = "https://val.test"; // notifyVal appends /process
  e.VAL_PROCESS_SECRET = "vps";
  const valPosts: any[] = [];
  let llmCalls = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any, init?: any) => {
    const url = String(u);
    if (url.endsWith("/browsers/dead-9")) return new Response("nf", { status: 404 }); // liveness probe + destroy
    if (url === "https://val.test/process") { valPosts.push(JSON.parse(String(init?.body ?? "{}"))); return new Response("ok", { status: 200 }); }
    if (url.includes("integrate.api.nvidia.com")) { llmCalls++; throw new Error("LLM must not run on the dead-session path"); }
    return new Response("x", { status: 500 });
  }) as any;
  const m = qMsg({ jobId: "j-dead" });
  try { await worker.queue(batch([m]), e); } finally { globalThis.fetch = realFetch; }
  assert.equal(m.acks, 1, "failure is terminal, not a queue retry");
  assert.equal(llmCalls, 0, "no LLM call on the dead-session path");
  const res = JSON.parse((await kv.get("result:j-dead"))!);
  assert.equal(res.status, "failed", `terminal text was: ${res.text}`);
  assert.ok(res.text.startsWith("❌"), "error terminal text");
  assert.ok(res.text.includes("dead-9") || res.text.includes("died twice"), "names the dead-session cause");
  assert.equal(await kv.get("state:j-dead"), null, "state cleaned at terminal");
  assert.equal(valPosts.length, 1, "exactly one owner callback");
  assert.equal(valPosts[0].status, "failed");
  // Late confirm against the terminal job: state is gone, so the decision is refused.
  const late = await worker.fetch(post("/task-confirm", { id: "j-dead", approve: true, nonce: "n-1" }, "s3cret"), e);
  assert.equal(late.status, 404, "late confirm on a terminal job rejected");
});

test("run7 regression: cancel landing mid-delivery is honored at the pause branch (no awaiting_confirmation overwrite, no re-arm)", async () => {
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  st.plan = { subtasks: [{ id: "1", title: "فرع", goal: "ج" }] } as any;
  st.next = "tool";
  st.pendingTools = [{ id: "tc-9", function: { name: "request_confirmation", arguments: JSON.stringify({ summary: "s", action: "click", target: "3", value: "" }) } }] as any;
  // Scripted KV: the cancel lands DURING the delivery - the delivery-start check
  // and the per-unit check still miss it (KV edge-cache window, exactly run7);
  // the pause-branch guard is the first read that sees it.
  let stoppedReads = 0;
  const base = new Map<string, string>([
    ["state:j1", JSON.stringify(st)],
    ["result:j1", JSON.stringify({ status: "stopped", text: "أُلغيت المهمة بطلب المالك.", at: 1 })], // written by /task-cancel
  ]);
  const kv = {
    get: async (k: string) => {
      if (k === "stopped:j1") { stoppedReads += 1; return stoppedReads >= 3 ? "1" : null; }
      return base.get(k) ?? null;
    },
    put: async (k: string, v: string) => { base.set(k, v); },
    delete: async (k: string) => { deleted.push(k); base.delete(k); },
    _m: base,
  };
  const deleted: string[] = [];
  const e = env(kv);
  const acks: string[] = [];
  await worker.queue({ queue: "web-agent-staging-jobs", messages: [{ body: { jobId: "j1" }, ack: () => acks.push("j1"), retry: () => {} }] } as any, e);
  assert.deepEqual(acks, ["j1"], "delivery acks (cleanup path, not a failure retry)");
  assert.equal(JSON.parse(base.get("result:j1")!).status, "stopped", "the stopped result record is NOT overwritten by awaiting_confirmation");
  assert.ok(!base.has("state:j1"), "state cleaned up - the cancelled job is not re-armed for owner approval");
  assert.ok(!deleted.includes("stopped:j1"), "the marker is never deleted by cleanup - deletion must not be the rearm window");
  assert.equal(e._sent.length, 0, "no queue re-enqueue");
});

test("cancel: owner callback fires with status stopped (job-correlated) and the stopped result stands", async () => {
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  (st as any).callbackChatId = 42;
  const kv = fakeKv({ "state:j1": JSON.stringify(st) });
  const e = { ...env(kv), VAL_CALLBACK_URL: "https://val.test/cb", VAL_PROCESS_SECRET: "vps" } as any;
  const realFetch = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = (async (u: any, init?: any) => { calls.push({ url: String(u), body: JSON.parse(String(init?.body ?? "{}")) }); return new Response("ok", { status: 200 }); }) as any;
  try {
    const res = await worker.fetch(post("/task-cancel", { id: "j1" }, "s3cret"), e);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json() as any, { ok: true, status: "stopped" });
    const cb = calls.find((c) => c.url === "https://val.test/cb/process");
    assert.ok(cb, "owner callback fired");
    assert.equal(cb.body.status, "stopped");
    assert.equal(cb.body.job_id, "j1");
    assert.equal(cb.body.chat_id, 42);
    assert.equal(cb.body.event_id, "j1:stopped");
    assert.equal(JSON.parse(kv._m.get("result:j1")!).status, "stopped");
    assert.ok(kv._m.get("stopped:j1"), "stop marker set");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("STAGING_FAULT stale-snapshot: first delivery records the snapshot and runs CURRENT state", async () => {
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  st.next = "done";
  st.finalText = "genB-current";
  const raw = JSON.stringify(st);
  const kv = fakeKv({ "state:j1": raw });
  const e = { ...env(kv), STAGING_FAULT: "stale-snapshot" } as any;
  const acks: string[] = [];
  await worker.queue({ queue: "web-agent-staging-jobs", messages: [{ body: { jobId: "j1" }, ack: () => acks.push("j1"), retry: () => {} }] } as any, e);
  assert.deepEqual(acks, ["j1"]);
  assert.equal(kv._m.get("snapshot:j1"), raw, "snapshot recorded from the first delivery");
  assert.equal(JSON.parse(kv._m.get("result:j1")!).text, "genB-current", "current generation terminalized, not a stale one");
  assert.ok(!kv._m.has("fault-used:j1"), "fault not consumed on the snapshot-recording delivery");
});

test("STAGING_FAULT stale-snapshot: one delivery replays the previous generation exactly once", async () => {
  const mk = (text: string) => { const s = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" }); s.next = "done"; s.finalText = text; return JSON.stringify(s); };
  const kv = fakeKv({ "state:j1": mk("genB-current"), "snapshot:j1": mk("genA-stale") });
  const e = { ...env(kv), STAGING_FAULT: "stale-snapshot" } as any;
  const acks: string[] = [];
  const batch = () => ({ queue: "web-agent-staging-jobs", messages: [{ body: { jobId: "j1" }, ack: () => acks.push("x"), retry: () => {} }] }) as any;
  await worker.queue(batch(), e);
  assert.equal(JSON.parse(kv._m.get("result:j1")!).text, "genA-stale", "the replayed delivery terminalized the STALE generation (the exercised hazard)");
  assert.ok(kv._m.get("fault-used:j1"), "fault marked used");
  assert.ok(kv._m.get("snapshot:j1"), "snapshot key preserved (TTL expiry only; the fault deletes nothing)");
});

test("confirm lifecycle: stopped marker expired but the 24h stopped RESULT record still refuses the decision", async () => {
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "s", toolCallId: "tc", intended: { action: "click", target: "3", value: "" }, nonce: "n-1", url: "", at: Date.now() };
  const kv = fakeKv({
    "state:j1": JSON.stringify(st),
    "result:j1": JSON.stringify({ status: "stopped", text: "أُلغيت", at: 1 }),
    // deliberately NO "stopped:j1" marker: the result record alone must refuse
  });
  const e = env(kv);
  const res = await worker.fetch(post("/task-confirm", { id: "j1", approve: true, nonce: "n-1" }, "s3cret"), e);
  assert.equal(res.status, 409, "decision refused on the lifecycle-matched stopped record");
  assert.equal(e._sent.length, 0, "no resume enqueued");
});

test("confirm: the stopped MARKER is primary evidence - a 409 stands even when the result record was overwritten", async () => {
  // The pause/deliver overwrite hazard: result: no longer shows stopped, but the
  // dedicated marker (24h TTL, never overwritten) must still refuse the decision.
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "s", toolCallId: "tc", intended: { action: "click", target: "3", value: "" }, nonce: "n-1", url: "", at: Date.now() };
  const kv = fakeKv({
    "state:j1": JSON.stringify(st),
    "stopped:j1": "1", // TTL 86400 since the lifecycle fix: outlives the >1h late reply
    "result:j1": JSON.stringify({ status: "awaiting_confirmation", confirm: "s", nonce: "n-1", at: 2 }), // overwritten by the pause branch
  });
  const e = env(kv);
  const res = await worker.fetch(post("/task-confirm", { id: "j1", approve: true, nonce: "n-1" }, "s3cret"), e);
  assert.equal(res.status, 409, "marker-visible refusal even with an overwritten result record");
  assert.equal(e._sent.length, 0, "no resume enqueued");
});

test("queued decision landing after a cancel is never applied (resume-branch stop guard)", async () => {
  // The decision was enqueued BEFORE the cancel and is delivered after it. The
  // delivery-start read misses the fresh marker (edge cache); the resume-branch
  // read sees it. The decision must not resume or arm the cancelled job.
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "s", toolCallId: "tc", intended: { action: "click", target: "3", value: "" }, nonce: "n-1", url: "", at: Date.now() };
  let stoppedReads = 0;
  const base = new Map<string, string>([
    ["state:j1", JSON.stringify(st)],
    ["result:j1", JSON.stringify({ status: "stopped", text: "أُلغيت", at: 1 })],
  ]);
  const kv = {
    get: async (k: string) => {
      if (k === "stopped:j1") { stoppedReads += 1; return stoppedReads >= 2 ? "1" : null; } // miss at start guard, hit at resume guard
      return base.get(k) ?? null;
    },
    put: async (k: string, v: string) => { base.set(k, v); },
    delete: async (k: string) => { base.delete(k); },
    _m: base,
  };
  const e = env(kv);
  const acks: string[] = [];
  await worker.queue({ queue: "web-agent-staging-jobs", messages: [{ body: { jobId: "j1", decision: "approve", nonce: "n-1" }, ack: () => acks.push("j1"), retry: () => {} }] } as any, e);
  assert.deepEqual(acks, ["j1"]);
  assert.ok(!base.has("state:j1"), "cleaned up, not resumed");
  assert.equal(e._sent.length, 0, "no continuation enqueued - the decision was never applied");
  assert.equal(JSON.parse(base.get("result:j1")!).status, "stopped", "stopped result stands");
});

test("rearm via stale state cache after cleanup is refused: the surviving marker 409s the confirm", async () => {
  // Reviewer scenario: cleanup deletes state, but a confirm request can still
  // read a STALE-CACHED state (~60s edge cache). The marker is never deleted,
  // so the confirm still meets a refusal instead of resuming the zombie state.
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "s", toolCallId: "tc", intended: { action: "click", target: "3", value: "" }, nonce: "n-1", url: "", at: Date.now() };
  const kv = fakeKv({
    "state:j1": JSON.stringify(st), // stale-cached read: state was actually deleted by cleanup
    "stopped:j1": "1",              // marker survives cleanup by design (25h TTL)
  });
  const e = env(kv);
  const res = await worker.fetch(post("/task-confirm", { id: "j1", approve: true, nonce: "n-1" }, "s3cret"), e);
  assert.equal(res.status, 409, "surviving marker refuses the confirm despite the stale state read");
  assert.equal(e._sent.length, 0, "no resume enqueued");
});

test("STAGING_FAULT stale-snapshot-resume: snapshot captures the APPROVED generation", async () => {
  const st = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" });
  st.next = "await_confirm";
  st.pendingConfirm = { summary: "s", toolCallId: "tc", intended: { action: "click", target: "3", value: "" }, nonce: "n-1", url: "", at: Date.now() };
  st.pendingTools = [{ id: "tc-1", function: { name: "act", arguments: JSON.stringify({ action: "click", target: "3", value: "" }) } }] as any;
  const kv = fakeKv({ "state:j1": JSON.stringify(st) });
  const e = { ...env(kv), STAGING_FAULT: "stale-snapshot-resume" } as any;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("x", { status: 500 })) as any; // no real LLM calls in unit tests
  try {
    const acks: string[] = [];
    await worker.queue({ queue: "web-agent-staging-jobs", messages: [{ body: { jobId: "j1", decision: "approved", nonce: "n-1" }, ack: () => acks.push("x"), retry: () => {} }] } as any, e);
    assert.deepEqual(acks, ["x"], "decision delivery acked");
    const snap = kv._m.get("snapshot:j1");
    assert.ok(snap, "approved generation captured");
    const snapSt = JSON.parse(snap);
    assert.equal(snapSt.approvedAction?.action, "click", "snapshot carries the UNCONSUMED approval");
    assert.equal(snapSt.approvedAction?.target, "3");
    assert.equal(snapSt.next, "llm", "snapshot is the post-decision generation");
    assert.ok(!kv._m.has("fault-used:j1"), "no replay consumed on the decision delivery itself");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("STAGING_FAULT stale-snapshot-resume: replayed stale approval meets the done ledger (no re-execution path taken)", async () => {
  // The replayed generation carries an UNCONSUMED approval for an act whose
  // ledger is already done: the tool step must answer from the ledger, so the
  // act is never re-executed. Non-numeric target keeps the R2 fail-closed out
  // of the way so the ledger path itself is what is exercised.
  const mkSt = (text: string) => { const s = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" }); s.next = "tool"; s.finalText = text; return s; };
  const approved = mkSt("");
  approved.approvedAction = { action: "click", target: "submit-btn", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 } as any;
  approved.pendingTools = [{ id: "tc-1", function: { name: "act", arguments: JSON.stringify({ action: "click", target: "submit-btn", value: "" }) } }] as any;
  const kv = fakeKv({
    "state:j1": JSON.stringify(mkSt("genB-current")),
    "snapshot:j1": JSON.stringify(approved),
    "act:j1:tc-1": JSON.stringify({ state: "done", result: "تم النقر سابقاً" }),
  });
  const e = { ...env(kv), STAGING_FAULT: "stale-snapshot-resume" } as any;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("x", { status: 500 })) as any;
  try {
    const acks: string[] = [];
    await worker.queue({ queue: "web-agent-staging-jobs", messages: [{ body: { jobId: "j1" }, ack: () => acks.push("x"), retry: () => {} }] } as any, e);
    assert.deepEqual(acks, ["x"], "replay delivery acked (no failure retry)");
    assert.ok(kv._m.get("fault-used:j1"), "replay consumed exactly once");
    const ledger = JSON.parse(kv._m.get("act:j1:tc-1")!);
    assert.equal(ledger.state, "done", "ledger untouched - recorded result replayed, no second intent write");
    assert.equal(ledger.result, "تم النقر سابقاً", "ledger result unmodified");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("STAGING_FAULT stale-snapshot-resume: replayed stale approval with a FRESH tool-call id meets the round marker (no re-execution)", async () => {
  // The decisive delivery-level case (reviewer): the replayed generation carries an
  // UNCONSUMED approval and a FRESH tool-call id (a next=llm replay re-issues the
  // call). The per-call ledger cannot see it; the actround marker must answer.
  const mkSt = (text: string) => { const s = initJobState(0, "مهمة", "", 0, { origin: "internal", perms: "interact", jobId: "j1" }); s.next = "tool"; s.finalText = text; return s; };
  const approved = mkSt("");
  approved.approvedAction = { action: "click", target: "submit-btn", value: "", url: "", elementSig: "", nonce: "n-1", expiresAt: Date.now() + 60_000, obsCount: 0 } as any;
  approved.pendingTools = [{ id: "tc-FRESH", function: { name: "act", arguments: JSON.stringify({ action: "click", target: "submit-btn", value: "" }) } }] as any;
  const kv = fakeKv({
    "state:j1": JSON.stringify(mkSt("genB-current")),
    "snapshot:j1": JSON.stringify(approved),
    "act:j1:tc-1": JSON.stringify({ state: "done", result: "تم النقر سابقاً" }),
    "actround:j1:n-1": JSON.stringify({ state: "done", result: "تم النقر سابقاً" }),
  });
  const e = { ...env(kv), STAGING_FAULT: "stale-snapshot-resume" } as any;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("x", { status: 500 })) as any;
  try {
    const acks: string[] = [];
    await worker.queue({ queue: "web-agent-staging-jobs", messages: [{ body: { jobId: "j1" }, ack: () => acks.push("x"), retry: () => {} }] } as any, e);
    assert.deepEqual(acks, ["x"], "replay delivery acked (no failure retry)");
    assert.ok(kv._m.get("fault-used:j1"), "replay consumed exactly once");
    assert.ok(!kv._m.has("act:j1:tc-FRESH"), "no intent under the fresh id: the round marker short-circuited execution");
    assert.equal(JSON.parse(kv._m.get("actround:j1:n-1")!).state, "done", "round marker untouched - recorded result replayed");
    assert.equal(JSON.parse(kv._m.get("act:j1:tc-1")!).state, "done", "original per-call ledger untouched");
  } finally {
    globalThis.fetch = realFetch;
  }
});

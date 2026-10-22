// Boots the real entry point (src/server.ts) as a subprocess, like Render does.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok -", name); };
const run = (env) => spawn("node", ["--experimental-strip-types", "--no-warnings", "src/server.ts"], { env: { PATH: process.env.PATH, ...env }, stdio: ["ignore", "pipe", "pipe"] });
await t("missing env -> exits 1 with a clear Arabic message listing every missing variable", () => {
  const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", "src/server.ts"], { env: { PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(r.status, 1); for (const v of ["TELEGRAM_BOT_TOKEN", "NVIDIA_API_KEY", "ADMIN_TELEGRAM_ID", "KERNEL_API_KEY"]) assert.ok(r.stderr.includes(v), v);
});
await t("boots, serves /health on $PORT, shuts down cleanly on SIGTERM (exit 0)", async () => {
  const p = run({ TELEGRAM_BOT_TOKEN: "1:x", NVIDIA_API_KEY: "k", ADMIN_TELEGRAM_ID: "1", KERNEL_API_KEY: "kk", PORT: "18091" });
  let out = ""; p.stdout.on("data", (d) => out += d); p.stderr.on("data", (d) => out += d);
  let health = null; for (let i = 0; i < 40 && !health; i++) { await sleep(150); try { health = await (await fetch("http://127.0.0.1:18091/health")).json(); } catch { /* not up yet */ } }
  assert.ok(health?.ok, "health: " + out); assert.ok(out.includes("listening on :18091"), out);
  const code = await new Promise((res) => { p.on("exit", res); p.kill("SIGTERM"); }); assert.equal(code, 0, out);
});
console.log(`\n${n} boot test groups passed`);

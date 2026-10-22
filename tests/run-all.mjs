import { spawnSync } from "node:child_process";
const files = ["unit", "browseagent", "readurl", "real/real", "app", "boot"].map((f) => `tests/${f}.test.mjs`);
let ok = true;
for (const f of files) { const r = spawnSync("node", ["--experimental-strip-types", "--no-warnings", f], { encoding: "utf8", timeout: 240000 }); const m = (r.stdout.match(/(\d+) [\w-]+ test groups passed/) ?? [])[0] ?? "FAILED"; console.log(`${r.status === 0 ? "✓" : "✗"} ${f}: ${m}`); if (r.status !== 0) { ok = false; console.log(r.stdout.slice(-1500), r.stderr.slice(-1500)); } }
process.exit(ok ? 0 : 1);

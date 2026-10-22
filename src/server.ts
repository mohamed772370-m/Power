import { loadConfig, missingVars } from "./config.ts";
import { createApp } from "./app.ts";

const miss = missingVars(process.env);
if (miss.length) { console.error(`[agent] متغيرات بيئة ناقصة: ${miss.join(", ")}`); process.exit(1); }
const app = createApp(loadConfig(process.env));
await app.start();
const shutdown = async (sig: string) => { console.log(`[agent] ${sig}: shutting down`); await app.stop(); process.exit(0); };
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (e) => console.error("[agent] unhandledRejection", e));

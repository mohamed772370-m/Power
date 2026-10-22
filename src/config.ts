import { createHash } from "node:crypto";

export interface Config {
  telegramToken: string; nvidiaKey: string; allowedIds: Set<number>; webhookSecret: string; publicUrl: string; port: number;
  kernelKey: string; steelKey: string; maxParallel: number; maxSessions: number; nimRpm: number; jobTimeoutMs: number;
  models: { leader?: string; fallback?: string; vision?: string };
}

export function missingVars(env: Record<string, string | undefined>): string[] {
  const miss: string[] = [];
  if (!(env.TELEGRAM_BOT_TOKEN ?? "").trim()) miss.push("TELEGRAM_BOT_TOKEN");
  if (!(env.NVIDIA_API_KEY ?? "").trim()) miss.push("NVIDIA_API_KEY");
  if (!(env.ADMIN_TELEGRAM_ID ?? env.ALLOWED_USER_IDS ?? "").trim()) miss.push("ADMIN_TELEGRAM_ID");
  if (!(env.KERNEL_API_KEY ?? "").trim() && !(env.STEEL_API_KEY ?? "").trim()) miss.push("KERNEL_API_KEY (أو STEEL_API_KEY)");
  return miss;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const miss = missingVars(env);
  if (miss.length) throw new Error(`متغيرات بيئة ناقصة: ${miss.join(", ")}`);
  const token = env.TELEGRAM_BOT_TOKEN!.trim();
  const ids = `${env.ADMIN_TELEGRAM_ID ?? ""},${env.ALLOWED_USER_IDS ?? ""}`.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) throw new Error("ADMIN_TELEGRAM_ID يجب أن يكون رقماً صحيحاً");
  const int = (k: string, d: number) => { const n = parseInt((env[k] ?? "").trim(), 10); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    telegramToken: token, nvidiaKey: env.NVIDIA_API_KEY!.trim(), allowedIds: new Set(ids),
    // derived from the token when not set, so changing the token never leaves a stale secret around
    webhookSecret: (env.WEBHOOK_SECRET ?? "").trim() || createHash("sha256").update(token).digest("hex").slice(0, 32),
    publicUrl: (env.WEBHOOK_URL ?? env.RENDER_EXTERNAL_URL ?? "").trim().replace(/\/+$/, ""),
    port: int("PORT", 10000), kernelKey: (env.KERNEL_API_KEY ?? "").trim(), steelKey: (env.STEEL_API_KEY ?? "").trim(),
    maxParallel: int("MAX_PARALLEL", 3), maxSessions: int("MAX_SESSIONS", 4), nimRpm: int("NIM_RPM", 38), jobTimeoutMs: int("JOB_TIMEOUT_MIN", 20) * 60_000,
    models: { leader: env.MODEL_LEADER?.trim() || undefined, fallback: env.MODEL_FALLBACK?.trim() || undefined, vision: env.MODEL_VISION?.trim() || undefined },
  };
}

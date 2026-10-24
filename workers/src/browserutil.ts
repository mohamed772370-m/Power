// Pure helpers for browsing (no Deno / network deps, so they are unit-testable).
// Added 2026-10-21: fixes for stateful-tool dedupe, mission browser steps, inspection cost, context bloat.

export const BROWSER_ACTIONS = [
  "observe", // read-only: current URL + numbered elements report, no side effects
  "goto", "click", "fill", "select", "check", "uncheck", "press_enter", "press_key", "scroll_down", "scroll_up", "back", "forward", "reload", "close_tab", "extract_links", "wait", "vision_check", "screenshot"] as const;
// Review round 5 (N1): forward/reload are navigation-class - a reload can
// resubmit a POST-result page and forward shares that vector - so they are
// gated like clicks: interact tier + owner approval only. They entered the
// read tier only with the M8 port, so gating them restores the original
// read-only pilot surface. "back" was read-tier BEFORE M8 and stays there to
// preserve the promised pilot surface (main, round 5); whether back's own
// POST-resubmission class also requires gating is flagged to the reviewer.
export const STATE_CHANGING_ACTIONS = ["click", "fill", "select", "check", "uncheck", "press_enter", "press_key", "forward", "reload"] as const;
// Permission tier travels WITH THE JOB (2026-10-24, integration design): the Telegram
// pilot path stays at "read" (state-changing actions blocked at schema, dispatcher and
// executor, unchanged). Internal /task jobs run at "interact" with a confirmation gate
// (request_confirmation) for commit-class actions. This replaces the old global
// READ_ONLY_MODE switch - lifting the pilot cap is a designed tier, not a flip.
export type PermissionTier = "read" | "interact";
export function allowedActions(tier: PermissionTier): readonly string[] {
  return tier === "interact"
    ? [...BROWSER_ACTIONS]
    : BROWSER_ACTIONS.filter((a) => !(STATE_CHANGING_ACTIONS as readonly string[]).includes(a));
}
export type BrowserAct = typeof BROWSER_ACTIONS[number];

// Stateful tools must never be served from the duplicate-call cache:
// scroll_down twice, click [4] on a changed page, or a reload are all legitimate repeats.
export function shouldDedupe(toolName: string): boolean {
  return toolName !== "browser_step" && toolName !== "browse_task";
}

// Mission steps carry a single free-text prompt. Accept: JSON {action,target,value}, "action | target | value", or a bare URL/domain.
export function parseBrowserStep(prompt: string): { action: BrowserAct; target: string; value: string } | null {
  const p = String(prompt ?? "").trim();
  if (!p) return null;
  const m = p.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const o = JSON.parse(m[0]);
      const action = String(o.action ?? "goto") as BrowserAct;
      if ((BROWSER_ACTIONS as readonly string[]).includes(action)) {
        return { action, target: String(o.target ?? o.url ?? ""), value: String(o.value ?? "") };
      }
    } catch { /* fall through */ }
  }
  const parts = p.split("|").map((s) => s.trim());
  if (parts.length >= 2 && (BROWSER_ACTIONS as readonly string[]).includes(parts[0])) {
    return { action: parts[0] as BrowserAct, target: parts[1] ?? "", value: parts[2] ?? "" };
  }
  const url = p.match(/https?:\/\/[^\s"'<>)\]،]+/i);
  if (url) return { action: "goto", target: url[0], value: "" };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(p)) return { action: "goto", target: p, value: "" };
  return null;
}

export const BROWSER_STEP_HINT =
  "(browser_step في الخطة ينفّذ حركة واحدة: اجعل engineered_prompt بصيغة JSON مثل " +
  "{\"action\":\"goto\",\"target\":\"https://example.com\"} أو رابطاً فقط)";

// Cheap heuristic: does a step result look failed? Used to skip the (costly) leader inspection for easy, healthy steps.
export function looksFailed(out: string): boolean {
  const s = String(out ?? "").trim();
  if (s.length < 20) return true;
  return /^(حدث خطأ|\(فشلت|\(انتهت|error|failed|traceback)/i.test(s) || /Traceback \(most recent call last\)/.test(s);
}

// Keep only the most recent browser page report in full; shrink older ones to URL + title.
// Returns number of characters saved.
export function compactBrowserHistory(messages: Array<{ role?: string; name?: string; content?: unknown }>): number {
  let last = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "tool" && messages[i]?.name === "browser_step") { last = i; break; }
  }
  let saved = 0;
  for (let i = 0; i < last; i++) {
    const m = messages[i];
    if (m?.role !== "tool" || m?.name !== "browser_step" || typeof m.content !== "string") continue;
    if (m.content.length < 500 || m.content.startsWith("[قديم]")) continue;
    const lines = m.content.split("\n");
    const url = lines.find((l) => l.startsWith("الرابط الحالي:")) ?? "";
    const title = lines.find((l) => l.startsWith("عنوان الصفحة:")) ?? "";
    const compact = url || title
      ? `[قديم] ${url} | ${title} (تفاصيل الصفحة السابقة حُذفت لتوفير السياق؛ آخر لقطة هي المرجع)`
      : `[قديم] ${m.content.slice(0, 160)}…`;
    saved += m.content.length - compact.length;
    m.content = compact;
  }
  return saved;
}

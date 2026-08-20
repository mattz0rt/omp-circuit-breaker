declare const process: { env: Record<string, string | undefined> };
/**
 * omp-error-circuit-breaker — pause a running session after N provider errors.
 *
 * Drop-in extension for Oh My Pi (`omp`) and Pi. Counts errors returned by
 * the LLM provider and, when a configurable threshold is reached, aborts the
 * active agent loop and blocks subsequent model calls until the user resumes.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";

// ── config types ───────────────────────────────────────────────────────────

export interface ParsedStatusSpec {
  all: boolean;
  set: Set<number>;
  ranges: Array<[number, number]>;
}

export interface BreakerConfig {
  threshold: number;
  spec: ParsedStatusSpec;
  specRaw: string;
  countMode: "consecutive" | "total";
  windowMs: number;
  cooldownMs: number;
  notifyEach: boolean;
}

// ── config helpers ─────────────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw != null && raw !== "" ? raw : fallback;
}

function parseStatusCodes(spec: string): ParsedStatusSpec {
  const s = spec.trim().toLowerCase();
  if (s === "all" || s === "*") return { all: true, set: new Set(), ranges: [] };
  const set = new Set<number>();
  const ranges: Array<[number, number]> = [];
  for (const part of s.split(",")) {
    const p = part.trim();
    if (!p) continue;
    if (p.includes("-")) {
      const segs = p.split("-");
      const a = Number.parseInt(segs[0]?.trim() ?? "", 10);
      const b = Number.parseInt(segs[1]?.trim() ?? "", 10);
      if (Number.isFinite(a) && Number.isFinite(b)) ranges.push([Math.min(a, b), Math.max(a, b)]);
    } else {
      const n = Number.parseInt(p, 10);
      if (Number.isFinite(n)) set.add(n);
    }
  }
  if (set.size === 0 && ranges.length === 0) {
    ranges.push([400, 599]);
  }
  return { all: false, set, ranges };
}

function statusMatches(status: number, spec: ParsedStatusSpec): boolean {
  if (spec.all) return true;
  if (spec.set.has(status)) return true;
  for (const [lo, hi] of spec.ranges) if (status >= lo && status <= hi) return true;
  return false;
}

function readStatus(event: unknown): number {
  if (typeof event === "object" && event !== null && "status" in event) {
    const v = (event as { status: unknown }).status;
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  }
  return 0;
}

function readErrorMessage(event: unknown): string {
  if (typeof event === "object" && event !== null && "errorMessage" in event) {
    const v = (event as { errorMessage: unknown }).errorMessage;
    return typeof v === "string" ? v : "";
  }
  if (typeof event === "object" && event !== null && "attempt" in event) {
    const v = (event as { attempt: unknown }).attempt;
    return `retry #${typeof v === "number" ? v : "?"}`;
  }
  return "retry";
}

function readFlagString(pi: ExtensionAPI, name: string): string | undefined {
  const v = pi.getFlag(name);
  return typeof v === "string" && v !== "" ? v : undefined;
}

// ── per-session state ─────────────────────────────────────────────────────

interface SessionState {
  errors: Array<{ ts: number; status: number; msg: string }>;
  paused: boolean;
  trippedAt: number | null;
  totalErrors: number;
  lastBlockNotify: number | null;
}

const states = new Map<string, SessionState>();
let lastCountedAt = 0;

function sessionId(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager;
  if (sm !== null && typeof sm === "object" && "getSessionId" in sm) {
    const fn = (sm as { getSessionId?: unknown }).getSessionId;
    if (typeof fn === "function") {
      try {
        const id = fn.call(sm);
        if (typeof id === "string" && id) return id;
      } catch {
        // fall through
      }
    }
  }
  return "global";
}

function getState(ctx: ExtensionContext): SessionState {
  const id = sessionId(ctx);
  let st = states.get(id);
  if (!st) {
    st = { errors: [], paused: false, trippedAt: null, totalErrors: 0, lastBlockNotify: null };
    states.set(id, st);
  }
  return st;
}

function pruneWindow(st: SessionState, windowMs: number): void {
  if (!windowMs) return;
  const cutoff = Date.now() - windowMs;
  st.errors = st.errors.filter(e => e.ts >= cutoff);
}

// ── extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI): void {
  pi.setLabel("Error Circuit Breaker");

  pi.registerFlag("error-breaker-threshold", {
    description: "Errors before pausing (default 3, env OMP_ERROR_BREAKER_THRESHOLD)",
    type: "string",
  });
  pi.registerFlag("error-breaker-status-codes", {
    description: "CSV/range of HTTP statuses that count (e.g. 429,500-599 or 'all')",
    type: "string",
  });
  pi.registerFlag("error-breaker-window-ms", {
    description: "Sliding window ms (0 = no window)",
    type: "string",
  });
  pi.registerFlag("error-breaker-cooldown-ms", {
    description: "Auto-resume after ms (0 = manual only)",
    type: "string",
  });

  function buildConfig(ctx?: ExtensionContext): BreakerConfig {
    const flagThreshold = ctx ? readFlagString(pi, "error-breaker-threshold") : undefined;
    const threshold = flagThreshold
      ? Number.parseInt(flagThreshold, 10) || envInt("OMP_ERROR_BREAKER_THRESHOLD", 3)
      : envInt("OMP_ERROR_BREAKER_THRESHOLD", 3);

    const flagCodes = ctx ? readFlagString(pi, "error-breaker-status-codes") : undefined;
    const specRaw = flagCodes ?? envStr("OMP_ERROR_BREAKER_STATUS_CODES", "400-599");

    const flagWindow = ctx ? readFlagString(pi, "error-breaker-window-ms") : undefined;
    const windowMs = flagWindow
      ? Number.parseInt(flagWindow, 10) || 0
      : envInt("OMP_ERROR_BREAKER_WINDOW_MS", 0);

    const flagCooldown = ctx ? readFlagString(pi, "error-breaker-cooldown-ms") : undefined;
    const cooldownMs = flagCooldown
      ? Number.parseInt(flagCooldown, 10) || 0
      : envInt("OMP_ERROR_BREAKER_COOLDOWN_MS", 0);

    const countModeRaw = envStr("OMP_ERROR_BREAKER_COUNT_MODE", "consecutive").toLowerCase();
    const countMode: "consecutive" | "total" = countModeRaw === "total" ? "total" : "consecutive";

    const notifyEach = envStr("OMP_ERROR_BREAKER_NOTIFY_EACH", "0") === "1";

    return {
      threshold: Math.max(1, threshold),
      spec: parseStatusCodes(specRaw),
      specRaw,
      countMode,
      windowMs,
      cooldownMs,
      notifyEach,
    };
  }

  function effectiveCount(st: SessionState, windowMs: number, countMode: string): number {
    if (countMode === "total") return st.totalErrors;
    pruneWindow(st, windowMs);
    return st.errors.length;
  }

  function syncUi(ctx: ExtensionContext, st: SessionState, c: BreakerConfig): void {
    if (st.paused) {
      const n = effectiveCount(st, c.windowMs, c.countMode);
      ctx.ui.setStatus("error-circuit-breaker", `⏸ breaker OPEN · ${n}/${c.threshold} errors`);
      ctx.ui.setWidget("error-circuit-breaker", [`⏸ paused — ${n} server error(s) (threshold ${c.threshold})`], { placement: "aboveEditor" });
    } else {
      const n = effectiveCount(st, c.windowMs, c.countMode);
      if (n > 0) ctx.ui.setStatus("error-circuit-breaker", `breaker ${n}/${c.threshold}`);
      else ctx.ui.setStatus("error-circuit-breaker", undefined);
      ctx.ui.setWidget("error-circuit-breaker", undefined);
    }
  }

  function trip(ctx: ExtensionContext, reason: string): void {
    const st = getState(ctx);
    if (st.paused) return;
    st.paused = true;
    st.trippedAt = Date.now();
    const c = buildConfig(ctx);
    const n = effectiveCount(st, c.windowMs, c.countMode);
    pi.logger.warn(`[error-circuit-breaker] TRIP ${n}/${c.threshold} — ${reason}`);
    ctx.ui.notify(`⏸ Paused: ${n} server error(s) hit threshold ${c.threshold}. ${reason}`, "error");
    syncUi(ctx, st, c);

    try {
      if (!ctx.isIdle()) ctx.abort();
    } catch {
      // host may not support abort in this mode
    }
    try {
      pi.appendEntry("error-circuit-breaker-trip", { ts: st.trippedAt, count: n, threshold: c.threshold, reason });
    } catch {
      // older hosts lack appendEntry
    }

    if (c.cooldownMs > 0) {
      const delay = c.cooldownMs;
      ctx.setTimeout(() => {
        const cur = states.get(sessionId(ctx));
        if (cur?.paused) {
          cur.paused = false;
          cur.errors = [];
          cur.trippedAt = null;
          ctx.ui.notify(`▶ Resumed (auto cooldown ${delay}ms elapsed)`, "info");
          syncUi(ctx, cur, buildConfig(ctx));
        }
      }, delay);
    }
  }

  function recordError(ctx: ExtensionContext, status: number, msg: string, source: "http" | "retry" = "http"): void {
    const now = Date.now();
    // Dedup only cross-source: a retry that follows an HTTP error within 750ms is the same saga — drop the retry.
    if (source === "retry" && now - lastCountedAt < 750) return;
    lastCountedAt = now;
    const st = getState(ctx);
    const c = buildConfig(ctx);
    pruneWindow(st, c.windowMs);
    st.errors.push({ ts: now, status, msg });
    st.totalErrors += 1;
    pruneWindow(st, c.windowMs);

    const n = effectiveCount(st, c.windowMs, c.countMode);
    if (typeof pi.logger.debug === "function") {
      pi.logger.debug(`[error-circuit-breaker] error ${status} — ${msg} (${n}/${c.threshold})`);
    }

    if (c.notifyEach) ctx.ui.notify(`⚠ server error ${status} (${n}/${c.threshold})`, "warning");
    syncUi(ctx, st, c);

    if (n >= c.threshold) {
      trip(ctx, `last error ${status}`);
    }
  }

  // manual reset removed — per-prompt ephemeral only (see before_agent_start)
  // kept for potential internal use, not exported via command
  function reset(ctx: ExtensionContext): void {
    const st = getState(ctx);
    st.errors = [];
    st.totalErrors = 0;
    st.paused = false;
    st.trippedAt = null;
    st.lastBlockNotify = null;
    const c = buildConfig(ctx);
    syncUi(ctx, st, c);
    pi.logger.info("[error-circuit-breaker] reset (internal)");
  }
  pi.on("after_provider_response", async (event: unknown, ctx: ExtensionContext) => {
    const c = buildConfig(ctx);
    const status = readStatus(event);
    const isError = status === 0 || statusMatches(status, c.spec);
    if (!isError) {
      const st = getState(ctx);
      if (!st.paused && c.countMode === "consecutive" && st.errors.length) {
        st.errors = [];
        syncUi(ctx, st, c);
      }
      return;
    }
    // Don't double-count errors while already paused — already tripped.
    const st = getState(ctx);
    if (st.paused) return;
    recordError(ctx, status, `HTTP ${status}`, "http");
  });
  pi.on("auto_retry_start", async (event: unknown, ctx: ExtensionContext) => {
    const st = getState(ctx);
    if (st.paused) return;
    const msg = readErrorMessage(event);
    recordError(ctx, 0, msg, "retry");
  });

  // ── blocking gate ─────────────────────────────────────────────────────

  pi.on("before_provider_request", async (_event: unknown, ctx: ExtensionContext) => {
    const st = getState(ctx);
    if (!st.paused) return;
    const now = Date.now();
    if (st.lastBlockNotify === null || now - st.lastBlockNotify > 2000) {
      st.lastBlockNotify = now;
      ctx.ui.notify("⏸ Blocked model call — breaker is OPEN", "warning");
    }
    try {
      ctx.abort();
    } catch {
      // ignore
    }
  });
  // ── per-prompt reset: new user prompt always starts at 0, same threshold ──
  pi.on("before_agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    const st = getState(ctx);
    const hadErrors = st.errors.length > 0 || st.totalErrors > 0;
    // ephemeral: next prompt starts clean
    st.errors = [];
    st.totalErrors = 0;
    st.paused = false;
    st.trippedAt = null;
    st.lastBlockNotify = null;
    if (hadErrors) {
      const c = buildConfig(ctx);
      syncUi(ctx, st, c);
    }
  });

  // Back-compat: some hosts emit agent_start instead of before_agent_start
  pi.on("agent_start", async (_event: unknown, ctx: ExtensionContext) => {
    const st = getState(ctx);
    if (st.paused || st.errors.length > 0 || st.totalErrors > 0) {
      // before_agent_start already cleared; this is a no-op guard if that event was missed
      st.errors = [];
      st.totalErrors = 0;
      st.paused = false;
      st.trippedAt = null;
      st.lastBlockNotify = null;
      const c = buildConfig(ctx);
      syncUi(ctx, st, c);
    }
  });
  // ── keep UI in sync ───────────────────────────────────────────────────

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    syncUi(ctx, getState(ctx), buildConfig(ctx));
  });
  pi.on("session_tree", async (_event: unknown, ctx: ExtensionContext) => {
    syncUi(ctx, getState(ctx), buildConfig(ctx));
  });
  pi.on("turn_start", async (_event: unknown, ctx: ExtensionContext) => {
    syncUi(ctx, getState(ctx), buildConfig(ctx));
  });

  async function handleCommand(args: string, ctx: ExtensionContext): Promise<void> {
    const raw = args.trim();
    const segs = raw.split(/\s+/).filter(Boolean);
    const verb = (segs[0] ?? "status").toLowerCase();
    const rest = segs.slice(1);
    const c = buildConfig(ctx);
    const st = getState(ctx);

    if (verb === "pause") {
      if (st.paused) ctx.ui.notify("Already paused", "info");
      else trip(ctx, "paused via /error-breaker pause");
      return;
    }
    if (verb === "config" || verb === "set" || verb === "threshold") {
      const val = rest[0];
      if (val == null) {
        ctx.ui.notify("Usage: /error-breaker config <threshold 1..100>", "warning");
        return;
      }
      const n = Number.parseInt(val, 10);
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        ctx.ui.notify("Threshold must be 1..100", "error");
        return;
      }
      process.env.OMP_ERROR_BREAKER_THRESHOLD = String(n);
      ctx.ui.notify(`Threshold → ${n} (env OMP_ERROR_BREAKER_THRESHOLD). Trips when ${n} errors occur.`, "info");
      syncUi(ctx, st, buildConfig(ctx));
      return;
    }
    // default: status. resume/reset removed — count is per-prompt ephemeral
    pruneWindow(st, c.windowMs);
    const n = effectiveCount(st, c.windowMs, c.countMode);
    const lines = [
      `Error Circuit Breaker — ${st.paused ? "⏸ PAUSED" : "▶ watching"}`,
      ` threshold : ${c.threshold}  (OMP_ERROR_BREAKER_THRESHOLD)`,
      ` statuses  : ${c.specRaw}  (OMP_ERROR_BREAKER_STATUS_CODES)`,
      ` countMode : ${c.countMode}  (OMP_ERROR_BREAKER_COUNT_MODE)`,
      ` window    : ${c.windowMs ? `${c.windowMs} ms` : "off"}  (OMP_ERROR_BREAKER_WINDOW_MS)`,
      ` count     : ${n}/${c.threshold}${st.totalErrors ? `  (lifetime ${st.totalErrors})` : ""}`,
      st.paused && st.trippedAt ? ` trippedAt : ${new Date(st.trippedAt).toLocaleString()}` : "",
      "",
      st.paused ? "Blocked" : "Watching for server errors…",
      "Commands: /error-breaker [status|pause|config <n>]  (alias /circuit-breaker)",
    ].filter(Boolean).join("\n");
    ctx.ui.notify(lines, st.paused ? "warning" : "info");
    try {
      // cross-version host compat — sendMessage payload shape varies by omp version
      const payload = { type: "custom", customType: "error-circuit-breaker-status", data: { paused: st.paused, count: n, threshold: c.threshold } } as unknown as { type: string; customType: string; data: unknown };
      pi.sendMessage(payload);
    } catch {
      // headless mode may not support sendMessage
    }
  }

  pi.registerCommand("error-breaker", {
    description: "Circuit breaker: pause after N server errors (status|pause|config <n>)",
    handler: async (args: string | undefined, ctx: ExtensionContext) => handleCommand(args ?? "", ctx),
  });
  pi.registerCommand("circuit-breaker", {
    description: "Alias for /error-breaker",
    handler: async (args: string | undefined, ctx: ExtensionContext) => handleCommand(args ?? "", ctx),
  });
}

import { shortToolLabel } from "./modules/live-session.mjs";

export const MAX_PILL_TEXT_LENGTH = 40;
export const COMPACT_PILL_TARGET_LENGTH = 19;
export const MAX_PILL_TOOLTIP_LENGTH = 200;

export function sanitizeAscii(value) {
  return String(value ?? "").replace(/[^\x20-\x7E\n]/g, "");
}

export function truncateAscii(value, maxLen) {
  const clean = sanitizeAscii(value).replace(/\s+/g, " ").trim();
  if (clean.length <= maxLen) return clean;
  if (maxLen <= 3) return clean.slice(0, maxLen);
  return `${clean.slice(0, maxLen - 3)}...`;
}

export function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "--";
  if (value < 1000) return String(Math.round(value));
  if (value < 100000) return `${(value / 1000).toFixed(1)}K`;
  if (value < 1000000) return `${Math.round(value / 1000)}K`;
  return `${(value / 1000000).toFixed(2)}M`;
}

export function formatBytes(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes < 1024) return `${Math.round(bytes)}B`;
  if (bytes < 1024 * 100) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

export function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}m ${secs}s`;
}

function formatShortSec(ms) {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m`;
}

export function formatTps(tps, decimals = 1) {
  if (typeof tps !== "number" || !Number.isFinite(tps) || tps < 0) return "--";
  if (tps >= 1000 || decimals === 0) return `${Math.round(tps)}`;
  return tps.toFixed(decimals);
}

export function resolveDisplayTps(throughput, sqliteLatest, smoothing = true, liveSession = null) {
  const lastValid = throughput?.lastValidTps ?? throughput?.rawTps ?? sqliteLatest?.tps ?? null;

  if (throughput?.phase === "streaming") {
    const val = smoothing ? (throughput.emaTps ?? throughput.rawTps) : throughput.rawTps;
    return {
      tps: typeof val === "number" ? val : 0,
      live: true,
      idle: false,
      lastTps: lastValid,
    };
  }

  const isIdle = liveSession?.isIdle === true
    || (throughput?.phase === "idle" && !liveSession?.isActiveTurn);
  if (isIdle) {
    return {
      tps: 0,
      live: false,
      idle: true,
      lastTps: typeof lastValid === "number" ? lastValid : null,
    };
  }

  if (throughput?.phase === "final" && typeof throughput.rawTps === "number") {
    return { tps: throughput.rawTps, live: false, idle: false, lastTps: throughput.rawTps };
  }
  if (typeof sqliteLatest?.tps === "number") {
    return { tps: sqliteLatest.tps, live: false, idle: false, lastTps: sqliteLatest.tps };
  }
  return { tps: 0, live: false, idle: true, lastTps: null };
}

function joinPillParts(base, ctxPart, runningAgents) {
  if (runningAgents > 0 && ctxPart) {
    const spaced = `${base} | ${ctxPart} | ${runningAgents}A`;
    if (spaced.length <= COMPACT_PILL_TARGET_LENGTH) return spaced;
    const tight = `${base} | ${ctxPart}|${runningAgents}A`;
    if (tight.length <= COMPACT_PILL_TARGET_LENGTH) return tight;
    return `${base}|${ctxPart}|${runningAgents}A`;
  }
  if (runningAgents > 0) {
    return `${base} | ${runningAgents}A`;
  }
  if (ctxPart) {
    const spaced = `${base} | ${ctxPart}`;
    return spaced.length <= COMPACT_PILL_TARGET_LENGTH ? spaced : `${base}|${ctxPart}`;
  }
  return base;
}

export function formatPillText({ throughput, context, sqliteLatest, subagents, liveSession, prefs }) {
  const mode = prefs?.pillMode || "compact";
  const smoothing = prefs?.smoothing !== false;
  const { tps, live, idle } = resolveDisplayTps(throughput, sqliteLatest, smoothing, liveSession);
  const runningAgents = Number(subagents?.runningCount || 0);
  const ctxPart = typeof context?.usedPct === "number" ? `${Math.round(context.usedPct)}%` : null;

  let base;
  if (liveSession?.isActiveTurn && liveSession?.stalledWaitMs >= 8000 && !live) {
    base = `WAIT ${formatShortSec(liveSession.stalledWaitMs)}`;
  } else if (liveSession?.isActiveTurn && liveSession?.activity?.kind === "approval") {
    base = "APPROVE";
  } else if (liveSession?.isActiveTurn && liveSession?.activity?.kind === "tool_running") {
    base = shortToolLabel(liveSession.activity.toolName);
  } else if (live) {
    const dec = mode === "detailed" ? 1 : 0;
    base = tps > 0 ? `* ${formatTps(tps, dec)} t/s` : "* ...";
  } else if (idle) {
    base = "0 t/s";
  } else {
    const dec = mode === "detailed" ? 1 : 0;
    base = `${formatTps(tps, dec)} t/s`;
  }

  let text;
  if (mode === "minimal") {
    text = runningAgents > 0 ? `${base} | ${runningAgents}A` : base;
  } else {
    text = joinPillParts(base, ctxPart, runningAgents);
  }

  return truncateAscii(text || "0 t/s", MAX_PILL_TEXT_LENGTH);
}

export function formatPillTooltip({ throughput, context, sqliteSession, sqliteLatest, subagents, liveSession, prefs }) {
  const smoothing = prefs?.smoothing !== false;
  const { tps, live, idle, lastTps } = resolveDisplayTps(throughput, sqliteLatest, smoothing, liveSession);
  const modelName = throughput?.model?.modelId || sqliteLatest?.modelId || context?.modelId || "no model";
  const med = sqliteSession?.totals?.medianTps;

  const parts = [modelName];

  if (liveSession?.isActiveTurn && liveSession?.stalledWaitMs >= 8000 && !live) {
    parts.push(`WAIT ${formatShortSec(liveSession.stalledWaitMs)}`);
  } else if (liveSession?.isActiveTurn && liveSession?.activity?.kind && liveSession.activity.kind !== "idle") {
    const act = liveSession.activity.label || "ACTIVE";
    if (live) {
      parts.push(`${act} ${formatTps(tps, 1)} t/s`);
    } else {
      parts.push(act);
    }
  } else if (idle) {
    const histBits = [];
    if (typeof lastTps === "number" && lastTps > 0) histBits.push(`last ${formatTps(lastTps, 0)}`);
    if (typeof med === "number" && med > 0) histBits.push(`med ${formatTps(med, 0)}`);
    parts.push(histBits.length ? `0 t/s (${histBits.join(", ")})` : "0 t/s (idle)");
  } else {
    const medStr = typeof med === "number" ? ` (med ${formatTps(med, 0)})` : "";
    parts.push(`${live ? "live" : "last"} ${formatTps(tps, 1)} t/s${medStr}`);
  }

  const ttftMs = throughput?.lastTtftMs ?? sqliteLatest?.cleanTtftMs;
  if (typeof ttftMs === "number") {
    parts.push(`TTFT ${formatDuration(ttftMs)}`);
  }

  if (typeof context?.usedPct === "number") {
    const win = context.contextWindow ? formatTokens(context.contextWindow) : "--";
    parts.push(`ctx ${formatTokens(context.usedTokens)}/${win} (${context.usedPct.toFixed(0)}%)`);
  }

  if (sqliteSession?.totals?.requestCount > 0 && sqliteSession.totals.cacheHitPct > 0) {
    parts.push(`cache ${Math.round(sqliteSession.totals.cacheHitPct)}%`);
  }

  const runningAgents = Number(subagents?.runningCount || 0);
  if (runningAgents > 0) {
    const firstActive = (subagents?.items || []).find((a) => a.status === "running");
    const toolNote = firstActive?.lastTool ? ` [${firstActive.lastTool}]` : "";
    parts.push(`${runningAgents} bg agent${runningAgents > 1 ? "s" : ""}${toolNote}`);
  }

  parts.push(prefs?.pillClickAction === "cycle-mode" ? "click: cycle" : "click: HUD");
  return truncateAscii(parts.join(" | "), MAX_PILL_TOOLTIP_LENGTH);
}

function asciiBar(pct, width = 20) {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
  const filled = Math.round((clamped / 100) * width);
  return `[${"#".repeat(filled)}${".".repeat(Math.max(0, width - filled))}]`;
}

function padRight(text, width) {
  const str = sanitizeAscii(text);
  if (str.length >= width) return str.slice(0, width);
  return str + " ".repeat(width - str.length);
}

function padLeft(text, width) {
  const str = sanitizeAscii(text);
  if (str.length >= width) return str.slice(0, width);
  return " ".repeat(width - str.length) + str;
}

export function formatAsciiReport(snapshot) {
  const lines = [];
  const tp = snapshot?.throughput;
  const ctx = snapshot?.context;
  const liveSess = snapshot?.live;
  const sess = snapshot?.sqlite?.session;
  const turn = snapshot?.sqlite?.turnProfile;
  const subagents = snapshot?.sqlite?.subagents;
  const benchmarks = snapshot?.sqlite?.benchmarks || [];
  const smoothing = snapshot?.prefs?.smoothing !== false;
  const { tps, live, idle, lastTps } = resolveDisplayTps(tp, sess?.latest, smoothing, liveSess);
  const modelId = tp?.model?.modelId || sess?.latest?.modelId || ctx?.modelId || "unknown";

  lines.push("=== ZCODE TELEMETRY REPORT ===");
  lines.push(`Session  : ${snapshot?.sessionId || "none"}`);
  lines.push(`Model    : ${modelId}`);
  lines.push(`Activity : ${liveSess?.activity?.label || (live ? "STREAMING" : "IDLE")}`);
  lines.push(`Range    : ${snapshot?.range || "today"}`);
  lines.push(`Generated: ${new Date(snapshot?.generatedAt || Date.now()).toISOString()}`);
  lines.push("");

  lines.push("--- THROUGHPUT & LATENCY ---");
  lines.push(`State   : ${live ? "STREAMING" : (idle ? "IDLE" : "ACTIVE")}`);
  lines.push(`Speed   : ${formatTps(tps)} tok/s (last ${formatTps(lastTps)} | med ${formatTps(sess?.totals?.medianTps)} | peak ${formatTps(tp?.peakTps)})`);
  lines.push(`TTFT    : ${formatDuration(tp?.lastTtftMs ?? sess?.latest?.cleanTtftMs)}`);
  lines.push(`Last Out: ${formatTokens(tp?.lastOutputTokens ?? sess?.latest?.outputTokens)} tokens`);
  lines.push("");

  lines.push("--- CONTEXT WINDOW ---");
  if (ctx) {
    const pct = ctx.usedPct ?? 0;
    lines.push(
      `Usage   : ${asciiBar(pct, 24)} ${pct.toFixed(1)}% (${formatTokens(ctx.usedTokens)} / ${formatTokens(ctx.contextWindow)})`,
    );
    if (ctx.runway) {
      lines.push(
        `Runway  : ~${ctx.runway.estTurnsLeft} turns to ${ctx.runway.warnPct}% (+${formatTokens(ctx.runway.tokensPerTurn)}/turn)`,
      );
    }
    for (const cat of ctx.categories || []) {
      const share = typeof cat.sharePct === "number" ? cat.sharePct : cat.pct;
      if (cat.tokens <= 0 && share <= 0) continue;
      lines.push(
        `  ${padRight(cat.label, 18)} ${padLeft(formatTokens(cat.tokens), 7)}  (${padLeft(`${share.toFixed(1)}%`, 5)})`,
      );
    }
  } else {
    lines.push("Usage   : unavailable for current session");
  }
  lines.push("");

  lines.push("--- SUBAGENTS ---");
  if (subagents?.items?.length) {
    lines.push(`Summary : ${subagents.runningCount} running / ${subagents.totalCount} total`);
    lines.push("STATE  TYPE         TASK                             REQS  TOOLS   OUT     TPS    TIME");
    for (const ag of subagents.items) {
      const tag = ag.status === "running"
        ? (ag.backgrounded ? "RUN*" : "RUN")
        : (ag.status === "error" ? "ERR" : "DONE");
      const kind = ag.subagentType || "subagent";
      lines.push(
        `${padRight(tag, 5)}  ${padRight(kind, 11)}  ${padRight(ag.title, 31)}  ${padLeft(String(ag.reqs), 4)}  ${padLeft(String(ag.tools), 5)}  ${padLeft(formatTokens(ag.outputTokens), 5)}  ${padLeft(formatTps(ag.medianTps), 6)}  ${padLeft(formatDuration(ag.elapsedMs), 7)}`,
      );
    }
  } else {
    lines.push("No subagents recorded for this session.");
  }
  lines.push("");

  lines.push("--- SESSION TOKENS & CACHE ---");
  const tot = sess?.totals;
  if (tot && tot.requestCount > 0) {
    const issuePart = typeof tot.issueRatePct === "number" && tot.issueRatePct > 0
      ? ` | issue ${tot.issueRatePct.toFixed(1)}%`
      : "";
    const cwPart = tot.cacheWriteTokens > 0
      ? ` | ${formatTokens(tot.cacheWriteTokens)} cache-write`
      : "";
    const ioPart = typeof tot.ioRatio === "number" && tot.ioRatio > 0
      ? ` | In:Out ${tot.ioRatio}:1`
      : "";
    lines.push(`Requests: ${tot.requestCount} (retries ${tot.retryCount}, rate-limits ${tot.rateLimitCount}${issuePart})`);
    lines.push(`Input   : ${formatTokens(tot.inputTokens)} total | ${formatTokens(tot.uncachedInputTokens)} fresh | ${formatTokens(tot.cacheReadTokens)} cache-read (${tot.cacheHitPct.toFixed(1)}%)${cwPart}`);
    lines.push(`Output  : ${formatTokens(tot.outputTokens)} total | ${formatTokens(tot.visibleOutputTokens)} visible | ${formatTokens(tot.reasoningTokens)} reasoning (${tot.reasoningRatioPct.toFixed(1)}%)${ioPart}`);
    if (sess.subagent?.requestCount > 0) {
      lines.push(`Subagent: ${sess.subagent.requestCount} reqs | ${formatTokens(sess.subagent.outputTokens)} out | ${formatTokens(sess.subagent.inputTokens)} in`);
    }
  } else {
    lines.push("No completed model requests recorded for this session yet.");
  }
  lines.push("");

  lines.push("--- TURN TIME BUDGET & TOOLS ---");
  if (turn?.timeBudget) {
    const b = turn.timeBudget;
    lines.push(`Latest Turn: wall ${formatDuration(b.wallMs)} | TTFT ${formatDuration(b.ttftMs)} | Decode ${formatDuration(b.decodeMs)} | Tools ${formatDuration(b.toolMs)} | RetryWait ${formatDuration(b.retryWaitMs)}`);
  }
  if (turn?.tools?.length) {
    lines.push("Tool               Calls    Avg     Max     Out   Err");
    for (const tool of turn.tools.slice(0, 8)) {
      lines.push(
        `${padRight(tool.toolName, 18)} ${padLeft(String(tool.calls), 5)}  ${padLeft(formatDuration(tool.avgMs), 6)}  ${padLeft(formatDuration(tool.maxMs), 6)}  ${padLeft(formatBytes(tool.outputBytes), 6)}  ${padLeft(String(tool.errors), 4)}`,
      );
    }
  } else {
    lines.push("No tool invocations recorded for this session yet.");
  }
  lines.push("");

  lines.push(`--- MODEL BENCHMARKS (${String(snapshot?.range || "today").toUpperCase()}) ---`);
  if (benchmarks.length) {
    lines.push("Model                    Reqs   Med t/s   P50 TTFT   P95 TTFT   Err%   Cache%");
    for (const row of benchmarks.slice(0, 8)) {
      const p50 = row.medianTtftMs ?? row.avgTtftMs;
      const errPct = typeof row.issueRatePct === "number" ? row.issueRatePct : 0;
      lines.push(
        `${padRight(row.modelId, 24)} ${padLeft(String(row.requestCount), 4)}  ${padLeft(formatTps(row.medianTps), 8)}  ${padLeft(formatDuration(p50), 8)}  ${padLeft(formatDuration(row.p95TtftMs), 8)}  ${padLeft(`${errPct.toFixed(1)}%`, 5)}  ${padLeft(`${row.cacheHitPct.toFixed(1)}%`, 6)}`,
      );
    }
  } else {
    lines.push("No model benchmark rows in selected range.");
  }

  return sanitizeAscii(lines.join("\n"));
}

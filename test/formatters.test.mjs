import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACT_PILL_TARGET_LENGTH,
  MAX_PILL_TEXT_LENGTH,
  MAX_PILL_TOOLTIP_LENGTH,
  formatAsciiReport,
  formatBytes,
  formatDuration,
  formatPillText,
  formatPillTooltip,
  formatTokens,
} from "../plugins/telemetry-hud/src/formatters.mjs";

const ASCII_ONLY_RE = /^[\x20-\x7E\n]*$/;

test("formatTokens, formatBytes, and formatDuration format boundaries cleanly", () => {
  assert.equal(formatTokens(null), "--");
  assert.equal(formatTokens(459), "459");
  assert.equal(formatTokens(12400), "12.4K");
  assert.equal(formatTokens(1820000), "1.82M");

  assert.equal(formatBytes(null), "--");
  assert.equal(formatBytes(-1), "--");
  assert.equal(formatBytes(0), "0B");
  assert.equal(formatBytes(840), "840B");
  assert.equal(formatBytes(12698), "12.4K");
  assert.equal(formatBytes(1572864), "1.5M");

  assert.equal(formatDuration(null), "--");
  assert.equal(formatDuration(668), "668ms");
  assert.equal(formatDuration(1400), "1.4s");
  assert.equal(formatDuration(134000), "2m 14s");
});

test("formatPillText shows 0 t/s when idle, live streaming states, stall/tool, and stays <= 19 chars", () => {
  const ctx = { usedPct: 51.2, usedTokens: 134000, contextWindow: 262000 };

  assert.equal(
    formatPillText({
      throughput: { phase: "idle", lastValidTps: 127 },
      context: ctx,
      subagents: { runningCount: 0 },
      liveSession: { isIdle: true, isActiveTurn: false, stalledWaitMs: 0, activity: { kind: "idle" } },
      prefs: { pillMode: "compact", smoothing: true },
    }),
    "0 t/s | 51%",
  );

  assert.equal(
    formatPillText({
      throughput: { phase: "idle", lastValidTps: 127 },
      context: ctx,
      subagents: { runningCount: 1 },
      liveSession: { isIdle: true, isActiveTurn: false, stalledWaitMs: 0, activity: { kind: "idle" } },
      prefs: { pillMode: "compact", smoothing: true },
    }),
    "0 t/s | 51% | 1A",
  );

  assert.equal(
    formatPillText({
      throughput: { phase: "idle", lastValidTps: 127 },
      context: ctx,
      subagents: { runningCount: 0 },
      liveSession: { isIdle: true, isActiveTurn: false, stalledWaitMs: 0, activity: { kind: "idle" } },
      prefs: { pillMode: "minimal", smoothing: true },
    }),
    "0 t/s",
  );

  const streamingSample = {
    throughput: { phase: "streaming", rawTps: 152.4, emaTps: 148.2, streamChannel: "tool_input", activeToolName: "Edit" },
    context: ctx,
    subagents: { runningCount: 2 },
    liveSession: { isIdle: false, isActiveTurn: true, stalledWaitMs: 0, activity: { kind: "tool_input", label: "EDIT" } },
  };
  for (const pillMode of ["compact", "detailed", "minimal"]) {
    const out = formatPillText({ ...streamingSample, prefs: { pillMode, smoothing: true } });
    assert.match(out, ASCII_ONLY_RE);
    assert.ok(out.length <= MAX_PILL_TEXT_LENGTH);
    assert.ok(out.length <= COMPACT_PILL_TARGET_LENGTH, `${pillMode} exceeded 19 chars: "${out}"`);
  }

  assert.equal(
    formatPillText({
      throughput: { phase: "final", rawTps: 120 },
      context: ctx,
      liveSession: { isIdle: false, isActiveTurn: true, stalledWaitMs: 18200, activity: { kind: "waiting", label: "WAIT" } },
      prefs: { pillMode: "compact" },
    }),
    "WAIT 18s | 51%",
  );

  assert.equal(
    formatPillText({
      throughput: { phase: "final", rawTps: 120 },
      context: ctx,
      liveSession: { isIdle: false, isActiveTurn: true, stalledWaitMs: 0, activity: { kind: "tool_running", label: "TOOL:Bash", toolName: "Bash" } },
      prefs: { pillMode: "compact" },
    }),
    "BASH | 51%",
  );

  assert.equal(
    formatPillText({
      throughput: { phase: "final", rawTps: 120 },
      context: ctx,
      liveSession: { isIdle: false, isActiveTurn: true, stalledWaitMs: 0, activity: { kind: "approval", label: "APPROVE" } },
      prefs: { pillMode: "compact" },
    }),
    "APPROVE | 51%",
  );
});

test("formatPillTooltip displays idle history, subagent info, and click mode within <= 200 ASCII chars", () => {
  const tip = formatPillTooltip({
    throughput: { phase: "idle", lastValidTps: 127.4, lastTtftMs: 668, model: { modelId: "glm-5.3-flash" } },
    context: { usedPct: 51.1, usedTokens: 134000, contextWindow: 262000 },
    sqliteSession: { totals: { requestCount: 5, cacheHitPct: 68, medianTps: 149 } },
    subagents: { runningCount: 1, items: [{ status: "running", lastTool: "Bash" }] },
    liveSession: { isIdle: true, isActiveTurn: false, stalledWaitMs: 0, activity: { kind: "idle" } },
    prefs: { smoothing: true, pillClickAction: "cycle-mode" },
  });

  assert.match(tip, ASCII_ONLY_RE);
  assert.ok(tip.length <= MAX_PILL_TOOLTIP_LENGTH);
  assert.ok(tip.includes("0 t/s (last 127, med 149)"));
  assert.ok(tip.includes("1 bg agent [Bash]"));
  assert.ok(tip.includes("click: cycle"));

  const huge = formatPillTooltip({
    throughput: { phase: "streaming", emaTps: 140, model: { modelId: `m-${"x".repeat(250)}\u{1F680}` } },
    prefs: { smoothing: true },
  });
  assert.match(huge, ASCII_ONLY_RE);
  assert.ok(huge.length <= MAX_PILL_TOOLTIP_LENGTH);
});

test("formatAsciiReport generates clean ASCII-only report with runway, cache-write, OUT bytes, and P95/ERR%", () => {
  const report = formatAsciiReport({
    generatedAt: 1795100000000,
    sessionId: "sess_abc123",
    range: "today",
    prefs: { smoothing: true },
    live: { isIdle: true, activity: { kind: "idle", label: "IDLE" } },
    throughput: {
      phase: "idle",
      lastValidTps: 105.2,
      peakTps: 132.8,
      lastOutputTokens: 900,
      lastTtftMs: 520,
      model: { modelId: "glm-5.3-flash" },
    },
    context: {
      usedTokens: 134000,
      contextWindow: 262000,
      usedPct: 51.1,
      runway: { warnPct: 85, tokensToWarn: 88700, tokensPerTurn: 11400, estTurnsLeft: 7 },
      categories: [{ id: "messages", label: "Messages", tokens: 95000, sharePct: 71.0 }],
    },
    sqlite: {
      session: {
        latest: { modelId: "glm-5.3-flash", cleanTtftMs: 520, outputTokens: 900 },
        totals: {
          requestCount: 4,
          retryCount: 1,
          rateLimitCount: 1,
          issueRatePct: 25.0,
          inputTokens: 100000,
          uncachedInputTokens: 38000,
          cacheReadTokens: 60000,
          cacheWriteTokens: 2000,
          cacheHitPct: 60,
          outputTokens: 3200,
          visibleOutputTokens: 2000,
          reasoningTokens: 1200,
          reasoningRatioPct: 37.5,
          ioRatio: 31.3,
          medianTps: 102.5,
        },
        subagent: { requestCount: 2, inputTokens: 12000, outputTokens: 800 },
      },
      subagents: {
        runningCount: 1,
        totalCount: 1,
        items: [
          {
            id: "sess_subagent_agent_1234",
            shortId: "1234",
            subagentType: "explore",
            backgrounded: true,
            title: "Audit diff",
            status: "running",
            reqs: 2,
            tools: 4,
            outputTokens: 800,
            medianTps: 120,
            elapsedMs: 12000,
          },
        ],
      },
      turnProfile: {
        timeBudget: { wallMs: 8000, ttftMs: 1200, decodeMs: 5000, toolMs: 1800, retryWaitMs: 0 },
        tools: [{ toolName: "Bash", calls: 3, avgMs: 400, maxMs: 900, outputBytes: 12698, errors: 0 }],
      },
      benchmarks: [
        { modelId: "glm-5.3-flash", requestCount: 4, medianTps: 102.5, avgTps: 100.1, avgTtftMs: 540, medianTtftMs: 520, p95TtftMs: 1400, issueRatePct: 25.0, cacheHitPct: 60 },
      ],
    },
  });

  assert.match(report, ASCII_ONLY_RE);
  assert.ok(report.includes("=== ZCODE TELEMETRY REPORT ==="));
  assert.ok(report.includes("Runway  : ~7 turns to 85% (+11.4K/turn)"));
  assert.ok(report.includes("cache-write"));
  assert.ok(report.includes("In:Out 31.3:1"));
  assert.ok(report.includes("Tool               Calls    Avg     Max     Out   Err"));
  assert.ok(report.includes("12.4K"));
  assert.ok(report.includes("P50 TTFT   P95 TTFT   Err%"));
  assert.ok(report.includes("25.0%"));
  assert.ok(report.includes("--- SUBAGENTS ---"));
  assert.ok(report.includes("explore"));
});

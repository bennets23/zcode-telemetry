import assert from "node:assert/strict";
import test from "node:test";

import { createThroughputTracker } from "../plugins/telemetry-hud/src/modules/throughput.mjs";

test("throughput tracker rejects 4700 t/s warmup and micro-burst final outliers", () => {
  let clock = 10000;
  const tracker = createThroughputTracker({ alpha: 0.22, historyLimit: 10, now: () => clock });

  tracker.hydrateHistory("sess_1", [
    { requestId: "hist_1", modelId: "glm-5.3-flash", tps: 140, outputTokens: 500, ttftMs: 500, completedAt: 5000 },
  ]);

  clock = 10002;
  const burst = tracker.recordEvent({
    sessionId: "sess_1",
    requestId: "req_1",
    model: { providerId: "z-ai", modelId: "glm-5.3-flash" },
    phase: "streaming",
    outputTokensPerSecond: 4700,
  });
  assert.equal(burst.phase, "streaming");
  assert.equal(burst.emaTps, 140);
  assert.equal(burst.peakTps, 140);

  clock = 10200;
  const warmupSpike = tracker.recordEvent({
    sessionId: "sess_1",
    requestId: "req_1",
    model: { providerId: "z-ai", modelId: "glm-5.3-flash" },
    phase: "streaming",
    outputTokensPerSecond: 600,
  });
  assert.equal(warmupSpike.emaTps, 140);

  clock = 10600;
  tracker.recordEvent({
    sessionId: "sess_1",
    requestId: "req_1",
    model: { providerId: "z-ai", modelId: "glm-5.3-flash" },
    phase: "streaming",
    outputTokensPerSecond: 120,
  });
  clock = 11100;
  const steady = tracker.recordEvent({
    sessionId: "sess_1",
    requestId: "req_1",
    model: { providerId: "z-ai", modelId: "glm-5.3-flash" },
    phase: "streaming",
    outputTokensPerSecond: 130,
  });
  assert.ok(steady.emaTps > 120 && steady.emaTps < 145);

  clock = 11400;
  const microBurstFinal = tracker.recordEvent({
    sessionId: "sess_1",
    requestId: "req_1",
    model: { providerId: "z-ai", modelId: "glm-5.3-flash" },
    phase: "final",
    outputTokensPerSecond: 4700,
    outputTokens: 70,
    timeToFirstTokenMs: 420,
  });
  assert.ok(microBurstFinal.rawTps < 200);
  assert.equal(microBurstFinal.history.length, 1);
  assert.equal(microBurstFinal.peakTps, 140);
  assert.equal(microBurstFinal.lastOutputTokens, 70);
});

test("recordStreamSample smooths Edit tool_input speed and markIdle preserves lastValidTps", () => {
  let clock = 1000;
  const tracker = createThroughputTracker({ alpha: 0.25, now: () => (clock += 200) });

  const s1 = tracker.recordStreamSample("sess_edit", { tps: 160, channel: "tool_input", toolName: "Edit" });
  assert.equal(s1.phase, "streaming");
  assert.equal(s1.streamChannel, "tool_input");
  assert.equal(s1.activeToolName, "Edit");
  assert.equal(s1.emaTps, 160);

  const ignored = tracker.recordStreamSample("sess_edit", { tps: 4500, channel: "tool_input", toolName: "Edit" });
  assert.equal(ignored.emaTps, 160);

  const s2 = tracker.recordStreamSample("sess_edit", { tps: 140, channel: "tool_input", toolName: "Edit" });
  assert.ok(Math.abs(s2.emaTps - 157.5) < 1e-6);

  const idle = tracker.markIdle("sess_edit");
  assert.equal(idle.phase, "idle");
  assert.equal(idle.streamChannel, null);
  assert.ok(Math.abs(idle.lastValidTps - 157.5) < 1e-6);
});

test("plausible final event snaps TPS and updates sparkline ring buffer", () => {
  let clock = 1000;
  const tracker = createThroughputTracker({ alpha: 0.22, historyLimit: 3, now: () => (clock += 500) });

  for (let i = 1; i <= 5; i++) {
    tracker.recordEvent({
      sessionId: "sess_1",
      requestId: `req_${i}`,
      model: { providerId: "p", modelId: "m" },
      phase: "streaming",
      outputTokensPerSecond: 90 + i * 10,
    });
    tracker.recordEvent({
      sessionId: "sess_1",
      requestId: `req_${i}`,
      model: { providerId: "p", modelId: "m" },
      phase: "final",
      outputTokensPerSecond: 100 + i * 10,
      outputTokens: 300,
      timeToFirstTokenMs: 500,
    });
  }

  const state = tracker.get("sess_1");
  assert.equal(state.rawTps, 150);
  assert.equal(state.emaTps, 150);
  assert.equal(state.history.length, 3);
  assert.deepEqual(
    state.history.map((h) => h.requestId),
    ["req_3", "req_4", "req_5"],
  );
  assert.equal(state.baselineTps, 140);
});

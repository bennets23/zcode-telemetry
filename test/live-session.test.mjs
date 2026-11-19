import assert from "node:assert/strict";
import test from "node:test";

import { createLiveSessionTracker } from "../plugins/telemetry-hud/src/modules/live-session.mjs";

test("conversation phase transitions track active turn and idle 0 t/s state", () => {
  let clock = 1000;
  const tracker = createLiveSessionTracker({ now: () => clock });

  const started = tracker.onConversationChange({
    sessionId: "sess_1",
    logEpoch: "e1",
    revision: 1,
    phase: "running",
  });
  assert.equal(started.becameActive, true);
  assert.equal(started.becameIdle, false);
  assert.equal(started.state.isActiveTurn, true);
  assert.equal(started.state.isIdle, false);
  assert.equal(started.state.activity.kind, "waiting");

  clock = 4500;
  assert.equal(tracker.get("sess_1").turnElapsedMs, 3500);

  const done = tracker.onConversationChange({
    sessionId: "sess_1",
    logEpoch: "e1",
    revision: 2,
    phase: "completedSuccess",
  });
  assert.equal(done.becameIdle, true);
  assert.equal(done.becameActive, false);
  assert.equal(done.state.isActiveTurn, false);
  assert.equal(done.state.isIdle, true);
  assert.equal(done.state.activity.kind, "idle");
  assert.equal(done.state.turnElapsedMs, 0);
});

test("reset rows do not emit synthetic deltas and Edit inputStreaming measures live tok/s", () => {
  let clock = 10000;
  const tracker = createLiveSessionTracker({ charsPerToken: 4, now: () => clock });
  tracker.onConversationChange({ sessionId: "sess_1", phase: "running" });

  const resetRes = tracker.onRowsChange("sess_1", {
    kind: "reset",
    logEpoch: "e1",
    revision: 1,
    rows: [
      { kind: "toolCall", rowId: 1, toolCallId: "old_tc", toolName: "Read", status: "success", inputText: "x".repeat(500) },
      { kind: "subagent", rowId: 2, subagentType: "explore", status: "running", summaryText: "Scan repo", childSessionId: "sess_sub_1", backgrounded: true },
    ],
  });
  assert.equal(resetRes.toolInputTps, null);
  assert.equal(resetRes.subagentsChanged, true);
  assert.equal(resetRes.state.liveSubagents[0].subagentType, "explore");
  assert.equal(resetRes.state.liveSubagents[0].backgrounded, true);

  clock = 11000;
  const c1 = tracker.onRowsChange("sess_1", {
    kind: "rows",
    logEpoch: "e1",
    revision: 2,
    upserted: [
      { kind: "toolCall", rowId: 3, toolCallId: "tc_edit", toolName: "Edit", status: "inputStreaming", inputText: "a".repeat(200) },
    ],
  });
  assert.equal(c1.toolInputTps, null);
  assert.equal(c1.state.activity.kind, "tool_input");
  assert.equal(c1.state.activity.label, "EDIT");

  clock = 11200;
  tracker.onRowsChange("sess_1", {
    kind: "rows",
    logEpoch: "e1",
    revision: 3,
    upserted: [
      { kind: "toolCall", rowId: 3, toolCallId: "tc_edit", toolName: "Edit", status: "inputStreaming", inputText: "a".repeat(400) },
    ],
  });

  clock = 11400;
  const c3 = tracker.onRowsChange("sess_1", {
    kind: "rows",
    logEpoch: "e1",
    revision: 4,
    upserted: [
      { kind: "toolCall", rowId: 3, toolCallId: "tc_edit", toolName: "Edit", status: "inputStreaming", inputText: "a".repeat(600) },
    ],
  });
  assert.ok(Math.abs(c3.toolInputTps - 250) < 0.1, `expected 250 t/s, got ${c3.toolInputTps}`);
  assert.equal(c3.toolName, "Edit");

  clock = 11600;
  const runRes = tracker.onRowsChange("sess_1", {
    kind: "rows",
    logEpoch: "e1",
    revision: 5,
    upserted: [
      { kind: "toolCall", rowId: 3, toolCallId: "tc_edit", toolName: "Edit", status: "running", inputText: "a".repeat(600) },
    ],
  });
  assert.equal(runRes.state.activity.kind, "tool_running");
  assert.equal(runRes.state.activity.label, "TOOL:Edit");

  clock = 11800;
  const doneRes = tracker.onRowsChange("sess_1", {
    kind: "rows",
    logEpoch: "e1",
    revision: 6,
    upserted: [
      { kind: "toolCall", rowId: 3, toolCallId: "tc_edit", toolName: "Edit", status: "success", inputText: "a".repeat(600) },
    ],
  });
  assert.equal(doneRes.state.activity.kind, "waiting");
});

test("stall detector triggers after 8s silent wait but pauses during tool execution", () => {
  let clock = 1000;
  const tracker = createLiveSessionTracker({ stallThresholdMs: 8000, now: () => clock });
  tracker.onConversationChange({ sessionId: "sess_1", phase: "running" });

  clock = 6000;
  assert.equal(tracker.get("sess_1").stalledWaitMs, 0);

  clock = 11000;
  assert.equal(tracker.get("sess_1").stalledWaitMs, 10000);

  tracker.onRowsChange("sess_1", {
    kind: "rows",
    logEpoch: "e1",
    revision: 2,
    upserted: [{ kind: "toolCall", rowId: 9, toolCallId: "tc_bash", toolName: "Bash", status: "running", inputText: "npm test" }],
  });
  clock = 35000;
  assert.equal(tracker.get("sess_1").stalledWaitMs, 0);
});

test("noteModelFinal clears active turn only when sessions.read conversationPhase is absent", () => {
  let clock = 1000;
  const tracker = createLiveSessionTracker({ now: () => clock });

  tracker.noteModelChunk("sess_ungranted");
  assert.equal(tracker.get("sess_ungranted").isActiveTurn, true);

  clock = 15000;
  const finUngranted = tracker.noteModelFinal("sess_ungranted");
  assert.equal(finUngranted.becameIdle, true);
  assert.equal(finUngranted.state.isActiveTurn, false);
  assert.equal(finUngranted.state.stalledWaitMs, 0);
  assert.equal(finUngranted.state.activity.kind, "idle");

  tracker.onConversationChange({ sessionId: "sess_granted", phase: "running" });
  tracker.noteModelChunk("sess_granted");
  const finGranted = tracker.noteModelFinal("sess_granted");
  assert.equal(finGranted.becameIdle, false);
  assert.equal(finGranted.state.isActiveTurn, true);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  computeContextRunway,
  createContextXrayTracker,
} from "../plugins/telemetry-hud/src/modules/context-xray.mjs";

test("context-xray calibrates draft-preview using prior request ratio and avoids 100% jumps", () => {
  const xray = createContextXrayTracker();

  const reqNorm = xray.ingest("sess_1", {
    sessionId: "sess_1",
    revision: 10,
    phase: "request",
    model: { providerId: "z-ai", modelId: "glm-5.3-flash", contextWindow: 262000 },
    estimatedTokens: 320000,
    providerInputTokens: 211600,
    freeTokens: 50400,
    categories: [
      { id: "messages", tokens: 240000, chars: 960000 },
      { id: "system_tool_schemas", tokens: 45440, chars: 181760 },
      { id: "meta_user_context", tokens: 18560, chars: 74240 },
      { id: "mcp_tool_schemas", tokens: 11520, chars: 46080 },
      { id: "skills", tokens: 2880, chars: 11520 },
      { id: "system_prompt", tokens: 1600, chars: 6400 },
    ],
  });

  assert.equal(reqNorm.usedTokens, 211600);
  assert.ok(Math.abs(reqNorm.usedPct - 80.8) < 0.2);

  const shareSum = reqNorm.categories.reduce((acc, c) => acc + c.sharePct, 0);
  assert.ok(Math.abs(shareSum - 100) < 0.5, `shareSum was ${shareSum}`);
  assert.equal(reqNorm.categories[0].id, "messages");
  assert.equal(reqNorm.categories[0].sharePct, 75);

  const winSum = reqNorm.categories.reduce((acc, c) => acc + c.windowPct, 0);
  assert.ok(Math.abs(winSum - reqNorm.usedPct) < 0.6, `winSum was ${winSum}`);

  const draftNorm = xray.ingest("sess_1", {
    sessionId: "sess_1",
    revision: 11,
    phase: "draft-preview",
    model: { providerId: "z-ai", modelId: "glm-5.3-flash", contextWindow: 262000 },
    estimatedTokens: 325000,
    categories: [
      { id: "messages", tokens: 245000, chars: 980000 },
      { id: "system_tool_schemas", tokens: 45440, chars: 181760 },
      { id: "meta_user_context", tokens: 18560, chars: 74240 },
      { id: "mcp_tool_schemas", tokens: 11520, chars: 46080 },
      { id: "skills", tokens: 2880, chars: 11520 },
      { id: "system_prompt", tokens: 1600, chars: 6400 },
    ],
  });

  assert.equal(draftNorm.calibrated, true);
  assert.ok(draftNorm.usedPct < 85, `draft-preview jumped to ${draftNorm.usedPct}%`);
  assert.ok(draftNorm.usedTokens < 220000);
});

test("setFallbackBaseline prevents 100% jump on cold draft-preview before first live request", () => {
  const xray = createContextXrayTracker();
  xray.setFallbackBaseline("sess_cold", { inputTokens: 205000, contextWindow: 262000 });

  const coldDraft = xray.ingest("sess_cold", {
    sessionId: "sess_cold",
    revision: 1,
    phase: "draft-preview",
    model: { providerId: "z-ai", modelId: "glm-5.3-flash", contextWindow: 262000 },
    estimatedTokens: 310000,
    categories: [
      { id: "messages", tokens: 250000, chars: 1000000 },
      { id: "system_tool_schemas", tokens: 60000, chars: 240000 },
    ],
  });

  assert.equal(coldDraft.calibrated, true);
  assert.equal(coldDraft.usedTokens, 205000);
  assert.ok(Math.abs(coldDraft.usedPct - 78.2) < 0.2);
});

test("computeContextRunway calculates remaining turns accurately", () => {
  const runway = computeContextRunway({
    usedTokens: 134000,
    contextWindow: 262000,
    tokensPerTurn: 11000,
    warnPct: 85,
  });
  assert.equal(runway.estTurnsLeft, 8);
  assert.equal(runway.tokensToWarn, 88700);

  const atLimit = computeContextRunway({
    usedTokens: 240000,
    contextWindow: 262000,
    tokensPerTurn: 10000,
    warnPct: 85,
  });
  assert.equal(atLimit.estTurnsLeft, 0);

  assert.equal(computeContextRunway({ usedTokens: 1000, contextWindow: null, tokensPerTurn: 1000 }), null);
  assert.equal(computeContextRunway({ usedTokens: 1000, contextWindow: 262000, tokensPerTurn: null }), null);
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";

import {
  computeDecodeMs,
  computeRowTps,
  createSqliteStatsReader,
  resolveRowPromptInputTokens,
} from "../plugins/telemetry-hud/src/modules/sqlite-stats.mjs";

function createTestDb() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zcode-telemetry-db-"));
  const dbPath = path.join(dir, "db.sqlite");

  const sql = `
    CREATE TABLE session (
      id text primary key,
      parent_id text,
      title text,
      task_type text,
      time_created integer,
      time_updated integer,
      last_outcome text
    );
    CREATE TABLE model_usage (
      id text primary key,
      logical_request_id text not null,
      attempt_index integer not null default 0,
      session_id text not null,
      turn_id text,
      query_source text not null,
      provider_id text not null,
      model_id text not null,
      status text not null,
      started_at integer not null,
      first_token_at integer,
      completed_at integer,
      duration_ms integer,
      time_to_first_token_ms integer,
      finish_reason text,
      tool_call_count integer not null default 0,
      input_tokens integer not null default 0,
      output_tokens integer not null default 0,
      reasoning_tokens integer not null default 0,
      cache_creation_input_tokens integer not null default 0,
      cache_read_input_tokens integer not null default 0,
      provider_total_tokens integer,
      computed_total_tokens integer not null default 0,
      retry_count integer not null default 0,
      error_type text
    );
    CREATE TABLE turn_usage (
      session_id text not null,
      turn_id text not null,
      status text not null,
      started_at integer not null,
      first_token_at integer,
      completed_at integer,
      duration_ms integer,
      time_to_first_token_ms integer,
      model_request_count integer not null default 0,
      model_retry_count integer not null default 0,
      tool_call_count integer not null default 0,
      tool_error_count integer not null default 0,
      input_tokens integer not null default 0,
      output_tokens integer not null default 0,
      reasoning_tokens integer not null default 0,
      cache_read_input_tokens integer not null default 0,
      primary key(session_id, turn_id)
    );
    CREATE TABLE tool_usage (
      id text primary key,
      session_id text not null,
      turn_id text,
      tool_call_id text not null,
      tool_name text not null,
      status text not null,
      started_at integer not null,
      completed_at integer,
      duration_ms integer,
      output_bytes integer not null default 0,
      truncated integer not null default 0
    );

    INSERT INTO session VALUES ('sess_1', NULL, 'Main task', 'interactive', 1000000, 1190000, NULL);
    INSERT INTO session VALUES ('sess_anth', NULL, 'Claude task', 'interactive', 1000000, 1190000, NULL);
    INSERT INTO session VALUES ('sess_subagent_agent_run1', 'sess_1', 'You are a senior Python reviewer checking diff correctness', 'subagent_child', 1170000, 1195000, NULL);
    INSERT INTO session VALUES ('sess_subagent_agent_done1', 'sess_1', 'Old completed review', 'subagent_child', 1020000, 1050000, 'completed');

    INSERT INTO model_usage VALUES (
      'u1', 'req_1', 0, 'sess_1', 'turn_1', 'main_turn', 'z-ai', 'glm-5.3-flash', 'completed',
      1000000, 1000500, 1005500, 5500, 500, 'stop', 0,
      10000, 500, 100, 1000, 6000, 10500, 10500, 0, NULL
    );
    INSERT INTO model_usage VALUES (
      'u2', 'req_2', 0, 'sess_1', 'turn_1', 'main_turn', 'z-ai', 'glm-5.3-flash', 'completed',
      1010000, 1070000, 1074000, 64000, 60000, 'tool-calls', 1,
      12000, 800, 200, 0, 8000, 12800, 12800, 1, 'rate_limited'
    );
    INSERT INTO model_usage VALUES (
      'u3', 'req_3', 0, 'sess_1', 'turn_1', 'main_turn', 'z-ai', 'glm-5.3-flash', 'completed',
      1080000, NULL, 1144000, 64000, NULL, 'tool-calls', 1,
      12000, 100, 0, 0, 8000, 12100, 12100, 1, 'rate_limited'
    );
    INSERT INTO model_usage VALUES (
      'u4_burst', 'req_burst', 0, 'sess_1', 'turn_1', 'main_turn', 'z-ai', 'glm-5.3-flash', 'completed',
      1145000, 1145400, 1145415, 415, 400, 'tool-calls', 1,
      12500, 70, 0, 0, 8000, 12570, 12570, 0, NULL
    );

    INSERT INTO model_usage VALUES (
      'u5_t2', 'req_t2', 0, 'sess_1', 'turn_2', 'main_turn', 'z-ai', 'glm-5.3-flash', 'completed',
      1150000, 1150400, 1152400, 2400, 400, 'stop', 0,
      22500, 300, 50, 0, 10000, 22800, 22800, 0, NULL
    );
    INSERT INTO model_usage VALUES (
      'u6_t3', 'req_t3', 0, 'sess_1', 'turn_3', 'main_turn', 'z-ai', 'glm-5.3-flash', 'completed',
      1160000, 1160500, 1163500, 3500, 500, 'stop', 0,
      34500, 450, 80, 0, 15000, 34950, 34950, 0, NULL
    );

    INSERT INTO model_usage VALUES (
      'a1', 'req_anth_1', 0, 'sess_anth', 'turn_a1', 'main_turn', 'anthropic', 'claude-sonnet', 'completed',
      1000000, 1000600, 1005600, 5600, 600, 'stop', 0,
      200, 500, 0, 1000, 150000, 151700, 700, 0, NULL
    );

    INSERT INTO model_usage VALUES (
      'sub_m1', 'req_sub1', 0, 'sess_subagent_agent_run1', 'turn_s1', 'subagent', 'z-ai', 'glm-5.3-flash', 'completed',
      1171000, 1171500, 1174000, 3000, 500, 'tool-calls', 1,
      20000, 375, 120, 0, 5000, 20375, 20375, 0, NULL
    );
    INSERT INTO model_usage VALUES (
      'sub_m2', 'req_sub2', 0, 'sess_subagent_agent_done1', 'turn_s2', 'subagent', 'z-ai', 'glm-5.3-flash', 'completed',
      1021000, 1021500, 1023500, 2500, 500, 'stop', 0,
      15000, 240, 80, 0, 3000, 15240, 15240, 0, NULL
    );

    INSERT INTO turn_usage VALUES (
      'sess_1', 'turn_1', 'completed', 1000000, 1000500, 1155000, 155000, 500,
      4, 2, 3, 1, 46500, 1470, 300, 30000
    );

    INSERT INTO tool_usage VALUES
      ('t1', 'sess_1', 'turn_1', 'c1', 'Bash', 'completed', 1074100, 1075100, 1000, 18400, 0),
      ('t2', 'sess_1', 'turn_1', 'c2', 'Read', 'error', 1075200, 1075300, 100, 2400, 1),
      ('t3', 'sess_1', 'turn_1', 'c3', 'Agent', 'running', 1170000, NULL, NULL, 0, 0),
      ('st1', 'sess_subagent_agent_run1', 'turn_s1', 'sc1', 'Bash', 'running', 1185000, NULL, NULL, 0, 0),
      ('st2', 'sess_subagent_agent_done1', 'turn_s2', 'sc2', 'Read', 'completed', 1024000, 1024050, 50, 500, 0);
  `;

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }

  return {
    dbPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("computeRowTps excludes TTFT, backoff, and <300ms micro-bursts", () => {
  assert.equal(computeDecodeMs({ first_token_at: 1000, completed_at: 3500 }), 2500);
  assert.equal(computeDecodeMs({ duration_ms: 5000, time_to_first_token_ms: 600 }), 4400);

  assert.equal(computeRowTps({
    output_tokens: 100,
    duration_ms: 64000,
    first_token_at: null,
    time_to_first_token_ms: null,
    retry_count: 1,
    error_type: "rate_limited",
  }), null);

  assert.equal(computeRowTps({
    output_tokens: 70,
    first_token_at: 1000,
    completed_at: 1015,
  }), null);
});

test("resolveRowPromptInputTokens reconciles inclusive and exclusive cache rows", () => {
  assert.equal(
    resolveRowPromptInputTokens({
      input_tokens: 10000,
      cache_read_input_tokens: 6000,
      cache_creation_input_tokens: 1000,
      output_tokens: 500,
      provider_total_tokens: 10500,
    }),
    10000,
  );

  assert.equal(
    resolveRowPromptInputTokens({
      input_tokens: 200,
      cache_read_input_tokens: 150000,
      cache_creation_input_tokens: 1000,
      output_tokens: 500,
      provider_total_tokens: 151700,
    }),
    151200,
  );
});

test("sqlite-stats reader traces live subagents, filters bursts, and computes pro metrics via node:sqlite and CLI fallback", async () => {
  const { dbPath, cleanup } = createTestDb();
  try {
    const reader = createSqliteStatsReader({ dbPath, now: () => 1200000 });
    const cliReader = createSqliteStatsReader({ dbPath, preferCli: true, now: () => 1200000 });

    const [overview, cliOverview] = await Promise.all([
      reader.getOverview("sess_1", "all"),
      cliReader.getOverview("sess_1", "all"),
    ]);

    assert.deepEqual(overview, cliOverview);

    const tot = overview.session.totals;
    assert.equal(tot.requestCount, 6);
    assert.equal(tot.outputTokens, 2220);
    assert.equal(tot.retryCount, 2);
    assert.equal(tot.rateLimitCount, 2);
    assert.equal(tot.medianTtftMs, 400);
    assert.equal(tot.p95TtftMs, 500);
    assert.ok(Math.abs(tot.issueRatePct - 33.3) < 0.2);
    assert.equal(overview.session.tokensPerTurn, 11000);

    assert.equal(overview.session.recentRequests.length, 4);
    assert.ok(overview.session.recentRequests.every((r) => r.tps <= 250));

    assert.equal(overview.subagents.totalCount, 2);
    assert.equal(overview.subagents.runningCount, 1);
    assert.equal(overview.subagents.items[0].status, "running");
    assert.equal(overview.subagents.items[0].title, "senior Python reviewer checking diff correctness");
    assert.equal(overview.subagents.items[0].lastTool, "Bash");
    assert.equal(overview.subagents.items[0].medianTps, 150);

    const budget = overview.turnProfile.timeBudget;
    assert.equal(budget.ttftMs, 900);
    assert.equal(budget.decodeMs, 9015);
    assert.equal(budget.toolMs, 1100);
    assert.equal(budget.retryWaitMs, 124000);
    assert.equal(overview.turnProfile.totalOutputBytes, 20800);
    assert.equal(overview.turnProfile.tools[0].outputBytes, 18400);

    const anthStats = await reader.getSessionStats("sess_anth");
    assert.equal(anthStats.totals.inputTokens, 151200);
    assert.equal(anthStats.totals.uncachedInputTokens, 200);
    assert.equal(anthStats.totals.cacheWriteTokens, 1000);
    assert.equal(anthStats.totals.cacheHitPct, 99.2);
    assert.equal(anthStats.totals.ioRatio, 302.4);

    const unsafe = await reader.getSessionStats("sess_1'; DROP TABLE model_usage;--");
    assert.equal(unsafe.totals.requestCount, 0);
  } finally {
    cleanup();
  }
});

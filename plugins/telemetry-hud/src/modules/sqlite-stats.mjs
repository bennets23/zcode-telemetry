import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  MAX_PLAUSIBLE_TPS,
  MIN_VALID_DECODE_MS,
  MIN_VALID_OUTPUT_TOKENS,
} from "./throughput.mjs";

const execFileAsync = promisify(execFile);

const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,200}$/;
const DEFAULT_DB_PATH = path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
const SUBAGENT_ACTIVITY_WINDOW_MS = 90000;
const SUBAGENT_DISPLAY_LIMIT = 12;

let nodeSqlitePromise = null;

function loadNodeSqlite() {
  if (!nodeSqlitePromise) {
    nodeSqlitePromise = import("node:sqlite")
      .then((mod) => mod?.DatabaseSync || null)
      .catch(() => null);
  }
  return nodeSqlitePromise;
}

function isValidSessionId(sessionId) {
  return typeof sessionId === "string" && SESSION_ID_RE.test(sessionId);
}

export function resolveRowPromptInputTokens(row) {
  const rawIn = Math.max(0, Number(row?.input_tokens || 0));
  const cacheRead = Math.max(0, Number(row?.cache_read_input_tokens || 0));
  const cacheWrite = Math.max(0, Number(row?.cache_creation_input_tokens || 0));
  const cacheSum = cacheRead + cacheWrite;
  if (rawIn <= 0) return cacheSum;
  if (cacheSum <= 0) return rawIn;

  const out = Math.max(0, Number(row?.output_tokens || 0));
  const total = Number(row?.provider_total_tokens ?? 0)
    || (rawIn >= cacheSum ? Number(row?.computed_total_tokens ?? 0) : 0);

  if (total > 0) {
    const inclusiveDiff = Math.abs(total - (rawIn + out));
    const exclusiveDiff = Math.abs(total - (rawIn + cacheSum + out));
    if (exclusiveDiff < inclusiveDiff) {
      return rawIn + cacheSum;
    }
    return rawIn;
  }

  if (rawIn < cacheSum) {
    return rawIn + cacheSum;
  }
  return rawIn;
}

export function computeDecodeMs(row) {
  if (!row || typeof row !== "object") return null;

  if (
    typeof row.first_token_at === "number" &&
    typeof row.completed_at === "number" &&
    row.completed_at > row.first_token_at
  ) {
    return row.completed_at - row.first_token_at;
  }

  if (
    typeof row.time_to_first_token_ms === "number" &&
    typeof row.duration_ms === "number" &&
    row.duration_ms > row.time_to_first_token_ms
  ) {
    return row.duration_ms - row.time_to_first_token_ms;
  }

  const retryCount = Number(row.retry_count || 0);
  if (
    retryCount === 0 &&
    !row.error_type &&
    typeof row.duration_ms === "number" &&
    row.duration_ms > 0
  ) {
    return row.duration_ms;
  }

  return null;
}

export function computeRowTps(row) {
  const outTokens = Number(row?.output_tokens || 0);
  if (outTokens < MIN_VALID_OUTPUT_TOKENS) return null;
  const decodeMs = computeDecodeMs(row);
  if (!decodeMs || decodeMs < MIN_VALID_DECODE_MS) return null;
  const tps = (outTokens * 1000) / decodeMs;
  if (!Number.isFinite(tps) || tps <= 0 || tps > MAX_PLAUSIBLE_TPS) return null;
  return tps;
}

export function rangeCutoffMs(range, nowMs = Date.now()) {
  if (range === "today") {
    const start = new Date(nowMs);
    start.setHours(0, 0, 0, 0);
    return start.getTime();
  }
  if (range === "7d") {
    return nowMs - 7 * 24 * 60 * 60 * 1000;
  }
  return 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function average(values) {
  if (!values.length) return null;
  const sum = values.reduce((acc, v) => acc + v, 0);
  return sum / values.length;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx];
}

function summarizeModelRows(rows) {
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let requestCount = 0;
  let retryCount = 0;
  let rateLimitCount = 0;
  let errorCount = 0;
  let issueRows = 0;
  const tpsList = [];
  const ttftList = [];

  for (const row of rows) {
    requestCount += 1;
    inputTokens += resolveRowPromptInputTokens(row);
    cacheReadTokens += Number(row.cache_read_input_tokens || 0);
    cacheWriteTokens += Number(row.cache_creation_input_tokens || 0);
    outputTokens += Number(row.output_tokens || 0);
    reasoningTokens += Number(row.reasoning_tokens || 0);
    const retry = Number(row.retry_count || 0);
    retryCount += retry;
    if (row.error_type === "rate_limited") rateLimitCount += 1;
    if (row.status === "error") errorCount += 1;
    if (row.status === "error" || Boolean(row.error_type) || retry > 0) {
      issueRows += 1;
    }

    const tps = computeRowTps(row);
    if (tps !== null) tpsList.push(tps);

    if (
      retry === 0 &&
      typeof row.time_to_first_token_ms === "number" &&
      row.time_to_first_token_ms >= 0
    ) {
      ttftList.push(row.time_to_first_token_ms);
    }
  }

  const uncachedInputTokens = Math.max(0, inputTokens - cacheReadTokens - cacheWriteTokens);
  const visibleOutputTokens = Math.max(0, outputTokens - reasoningTokens);
  const cacheHitPct = inputTokens > 0
    ? Math.min(100, Math.round((cacheReadTokens / inputTokens) * 1000) / 10)
    : 0;
  const reasoningRatioPct = outputTokens > 0
    ? Math.min(100, Math.round((reasoningTokens / outputTokens) * 1000) / 10)
    : 0;
  const ioRatio = outputTokens > 0 ? Math.round((inputTokens / outputTokens) * 10) / 10 : null;
  const issueRatePct = requestCount > 0 ? Math.round((issueRows / requestCount) * 1000) / 10 : 0;

  return {
    requestCount,
    inputTokens,
    uncachedInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    visibleOutputTokens,
    cacheHitPct,
    reasoningRatioPct,
    ioRatio,
    retryCount,
    rateLimitCount,
    errorCount,
    issueRows,
    issueRatePct,
    avgTps: average(tpsList),
    medianTps: median(tpsList),
    avgTtftMs: average(ttftList),
    medianTtftMs: percentile(ttftList, 0.5),
    p95TtftMs: percentile(ttftList, 0.95),
  };
}

function computeTokensPerTurn(rows) {
  const byTurn = new Map();
  for (const row of rows) {
    const turnId = row.turn_id;
    const inTok = resolveRowPromptInputTokens(row);
    if (!turnId || inTok <= 0) continue;
    byTurn.set(turnId, inTok);
  }
  const turnInputs = [...byTurn.values()].slice(-14);
  const deltas = [];
  for (let i = 1; i < turnInputs.length; i++) {
    const diff = turnInputs[i] - turnInputs[i - 1];
    if (diff > 0) deltas.push(diff);
  }
  const med = median(deltas);
  return med !== null ? Math.round(med) : null;
}

function cleanSubagentTitle(rawTitle, fallbackId) {
  const clean = String(rawTitle || "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^you are (?:an?\s+)?/i, "");
  if (clean) return clean.slice(0, 72);
  return String(fallbackId || "subagent").slice(0, 32);
}

export function createSqliteStatsReader(options = {}) {
  const dbPath = options.dbPath || DEFAULT_DB_PATH;
  const explicitBin = options.sqliteBin || null;
  const preferCli = Boolean(options.preferCli || explicitBin);
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  let resolvedCliBin = null;

  async function queryJson(sql) {
    try {
      await access(dbPath);
    } catch {
      return [];
    }

    if (!preferCli) {
      const DatabaseSync = await loadNodeSqlite();
      if (DatabaseSync) {
        let db = null;
        try {
          db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
          const rows = db.prepare(sql).all();
          return Array.isArray(rows) ? rows.map((row) => ({ ...row })) : [];
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/syntax error|no such table|no such column/i.test(msg)) {
            return [];
          }
        } finally {
          try {
            db?.close?.();
          } catch {
          }
        }
      }
    }

    const candidates = explicitBin
      ? [explicitBin]
      : (resolvedCliBin ? [resolvedCliBin] : ["sqlite3", "/usr/bin/sqlite3"]);

    for (const bin of candidates) {
      try {
        const { stdout } = await execFileAsync(
          bin,
          ["-readonly", "-json", "-cmd", ".timeout 1000", dbPath, sql],
          { timeout: 2500, maxBuffer: 4 * 1024 * 1024 },
        );
        if (!explicitBin) resolvedCliBin = bin;
        const trimmed = stdout.trim();
        if (!trimmed) return [];
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed) ? parsed : [];
      } catch (err) {
        if (err && typeof err === "object" && err.code === "ENOENT") {
          continue;
        }
        return [];
      }
    }

    return [];
  }

  async function getSessionStats(sessionId) {
    if (!isValidSessionId(sessionId)) {
      return {
        latest: null,
        latestInputTokens: null,
        tokensPerTurn: null,
        totals: summarizeModelRows([]),
        mainTurn: summarizeModelRows([]),
        subagent: summarizeModelRows([]),
        recentRequests: [],
      };
    }

    const rows = await queryJson(`
      SELECT
        logical_request_id,
        turn_id,
        query_source,
        provider_id,
        model_id,
        status,
        started_at,
        first_token_at,
        completed_at,
        duration_ms,
        time_to_first_token_ms,
        finish_reason,
        tool_call_count,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        provider_total_tokens,
        computed_total_tokens,
        retry_count,
        error_type
      FROM model_usage
      WHERE session_id = '${sessionId}'
        AND status IN ('completed', 'error', 'cancelled')
      ORDER BY COALESCE(completed_at, started_at) ASC;
    `);

    const totals = summarizeModelRows(rows);
    const mainRows = rows.filter((r) => r.query_source === "main_turn");
    const subRows = rows.filter((r) => r.query_source === "subagent");

    const completedMain = mainRows.filter((r) => r.status === "completed" && Number(r.output_tokens || 0) > 0);
    const latestRow = completedMain.length > 0
      ? completedMain[completedMain.length - 1]
      : (rows.length > 0 ? rows[rows.length - 1] : null);

    let latest = null;
    if (latestRow) {
      const decodeMs = computeDecodeMs(latestRow);
      const retryCount = Number(latestRow.retry_count || 0);
      const hasRetry = retryCount > 0 || latestRow.error_type === "rate_limited";
      const durationMs = typeof latestRow.duration_ms === "number" ? latestRow.duration_ms : null;
      const retryWaitMs = hasRetry && durationMs !== null
        ? Math.max(0, durationMs - (decodeMs || 0))
        : 0;
      const cleanTtftMs = !hasRetry && typeof latestRow.time_to_first_token_ms === "number"
        ? latestRow.time_to_first_token_ms
        : null;

      latest = {
        requestId: latestRow.logical_request_id,
        modelId: latestRow.model_id,
        providerId: latestRow.provider_id,
        querySource: latestRow.query_source,
        tps: computeRowTps(latestRow),
        ttftMs: typeof latestRow.time_to_first_token_ms === "number" ? latestRow.time_to_first_token_ms : null,
        cleanTtftMs,
        retryWaitMs,
        decodeMs,
        durationMs,
        inputTokens: resolveRowPromptInputTokens(latestRow),
        outputTokens: Number(latestRow.output_tokens || 0),
        reasoningTokens: Number(latestRow.reasoning_tokens || 0),
        cacheReadTokens: Number(latestRow.cache_read_input_tokens || 0),
        cacheWriteTokens: Number(latestRow.cache_creation_input_tokens || 0),
        retryCount,
        errorType: latestRow.error_type || null,
        completedAt: latestRow.completed_at ?? latestRow.started_at ?? null,
      };
    }

    const latestWithInput = [...completedMain].reverse().find((r) => resolveRowPromptInputTokens(r) > 0);
    const latestInputTokens = latestWithInput ? resolveRowPromptInputTokens(latestWithInput) : null;

    const recentRequests = completedMain
      .map((row) => ({
        requestId: row.logical_request_id,
        modelId: row.model_id,
        tps: computeRowTps(row),
        ttftMs: Number(row.retry_count || 0) === 0 && typeof row.time_to_first_token_ms === "number"
          ? row.time_to_first_token_ms
          : null,
        outputTokens: Number(row.output_tokens || 0),
        completedAt: row.completed_at ?? row.started_at ?? null,
      }))
      .filter((item) => item.tps !== null)
      .slice(-30);

    return {
      latest,
      latestInputTokens,
      tokensPerTurn: computeTokensPerTurn(completedMain),
      totals,
      mainTurn: summarizeModelRows(mainRows),
      subagent: summarizeModelRows(subRows),
      recentRequests,
    };
  }

  async function getTurnProfile(sessionId) {
    if (!isValidSessionId(sessionId)) {
      return { latestTurn: null, timeBudget: null, totalToolMs: 0, totalOutputBytes: 0, tools: [] };
    }

    const [turnRows, toolRows, sessionToolSummary] = await Promise.all([
      queryJson(`
        SELECT
          turn_id,
          status,
          started_at,
          first_token_at,
          completed_at,
          duration_ms,
          time_to_first_token_ms,
          model_request_count,
          model_retry_count,
          tool_call_count,
          tool_error_count,
          input_tokens,
          output_tokens,
          reasoning_tokens,
          cache_read_input_tokens
        FROM turn_usage
        WHERE session_id = '${sessionId}'
        ORDER BY started_at DESC
        LIMIT 1;
      `),
      queryJson(`
        SELECT
          tool_name,
          COUNT(*) AS calls,
          ROUND(AVG(COALESCE(duration_ms, 0)), 1) AS avg_ms,
          MAX(COALESCE(duration_ms, 0)) AS max_ms,
          SUM(COALESCE(duration_ms, 0)) AS total_ms,
          SUM(COALESCE(output_bytes, 0)) AS output_bytes,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
          SUM(COALESCE(truncated, 0)) AS truncated_count
        FROM tool_usage
        WHERE session_id = '${sessionId}'
        GROUP BY tool_name
        ORDER BY calls DESC, total_ms DESC
        LIMIT 12;
      `),
      queryJson(`
        SELECT
          SUM(COALESCE(duration_ms, 0)) AS total_tool_ms,
          SUM(COALESCE(output_bytes, 0)) AS total_output_bytes
        FROM tool_usage
        WHERE session_id = '${sessionId}';
      `),
    ]);

    const latestTurnRow = turnRows[0] || null;
    let timeBudget = null;

    if (latestTurnRow && isValidSessionId(latestTurnRow.turn_id)) {
      const turnId = latestTurnRow.turn_id;
      const [turnModelRows, turnToolRows] = await Promise.all([
        queryJson(`
          SELECT
            duration_ms,
            time_to_first_token_ms,
            first_token_at,
            completed_at,
            retry_count,
            error_type
          FROM model_usage
          WHERE session_id = '${sessionId}'
            AND turn_id = '${turnId}'
            AND query_source = 'main_turn';
        `),
        queryJson(`
          SELECT SUM(COALESCE(duration_ms, 0)) AS total_ms
          FROM tool_usage
          WHERE session_id = '${sessionId}' AND turn_id = '${turnId}';
        `),
      ]);

      let ttftMs = 0;
      let decodeMs = 0;
      let retryWaitMs = 0;
      let rateLimitHits = 0;

      for (const mr of turnModelRows) {
        const dMs = computeDecodeMs(mr);
        if (dMs !== null) decodeMs += dMs;

        const hasRetry = Number(mr.retry_count || 0) > 0 || mr.error_type === "rate_limited";
        if (mr.error_type === "rate_limited") rateLimitHits += 1;

        if (hasRetry) {
          const totalDur = Number(mr.duration_ms || 0);
          retryWaitMs += Math.max(0, totalDur - (dMs || 0));
        } else if (typeof mr.time_to_first_token_ms === "number" && mr.time_to_first_token_ms >= 0) {
          ttftMs += mr.time_to_first_token_ms;
        }
      }

      const toolMs = Number(turnToolRows[0]?.total_ms || 0);
      const totalAccounted = ttftMs + decodeMs + toolMs + retryWaitMs;
      const wallMs = Number(latestTurnRow.duration_ms || totalAccounted);

      timeBudget = {
        turnId,
        wallMs,
        ttftMs,
        decodeMs,
        toolMs,
        retryWaitMs,
        rateLimitHits,
        modelRequests: Number(latestTurnRow.model_request_count || 0),
        modelRetries: Number(latestTurnRow.model_retry_count || 0),
        toolCalls: Number(latestTurnRow.tool_call_count || 0),
        toolErrors: Number(latestTurnRow.tool_error_count || 0),
      };
    }

    return {
      latestTurn: latestTurnRow
        ? {
            turnId: latestTurnRow.turn_id,
            status: latestTurnRow.status,
            durationMs: latestTurnRow.duration_ms,
            ttftMs: latestTurnRow.time_to_first_token_ms,
            modelRequests: Number(latestTurnRow.model_request_count || 0),
            modelRetries: Number(latestTurnRow.model_retry_count || 0),
            toolCalls: Number(latestTurnRow.tool_call_count || 0),
            toolErrors: Number(latestTurnRow.tool_error_count || 0),
            outputTokens: Number(latestTurnRow.output_tokens || 0),
            reasoningTokens: Number(latestTurnRow.reasoning_tokens || 0),
          }
        : null,
      timeBudget,
      totalToolMs: Number(sessionToolSummary[0]?.total_tool_ms || 0),
      totalOutputBytes: Number(sessionToolSummary[0]?.total_output_bytes || 0),
      tools: toolRows.map((r) => ({
        toolName: String(r.tool_name || ""),
        calls: Number(r.calls || 0),
        avgMs: Number(r.avg_ms || 0),
        maxMs: Number(r.max_ms || 0),
        totalMs: Number(r.total_ms || 0),
        outputBytes: Number(r.output_bytes || 0),
        errors: Number(r.errors || 0),
        truncatedCount: Number(r.truncated_count || 0),
      })),
    };
  }

  async function getSubagents(sessionId) {
    if (!isValidSessionId(sessionId)) {
      return {
        runningCount: 0,
        totalCount: 0,
        parentRunningAgentCalls: 0,
        totals: { requestCount: 0, toolCount: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 },
        items: [],
      };
    }

    const [childRows, parentAgentRows, childModelRows] = await Promise.all([
      queryJson(`
        SELECT
          s.id,
          s.title,
          s.task_type,
          s.time_created,
          s.time_updated,
          s.last_outcome,
          (SELECT status FROM turn_usage tu WHERE tu.session_id = s.id ORDER BY tu.started_at DESC LIMIT 1) AS turn_status,
          (SELECT COUNT(*) FROM model_usage m WHERE m.session_id = s.id AND m.status IN ('completed', 'error', 'cancelled')) AS reqs,
          (SELECT COUNT(*) FROM tool_usage t WHERE t.session_id = s.id) AS tools,
          (SELECT COUNT(*) FROM tool_usage t WHERE t.session_id = s.id AND t.status = 'running') AS running_tools,
          (SELECT tool_name FROM tool_usage t WHERE t.session_id = s.id ORDER BY t.started_at DESC LIMIT 1) AS last_tool,
          (SELECT MAX(t.started_at) FROM tool_usage t WHERE t.session_id = s.id) AS last_tool_at,
          (SELECT MAX(COALESCE(m.completed_at, m.started_at)) FROM model_usage m WHERE m.session_id = s.id) AS last_model_at,
          (SELECT COALESCE(SUM(m.input_tokens), 0) FROM model_usage m WHERE m.session_id = s.id) AS input_tokens,
          (SELECT COALESCE(SUM(m.output_tokens), 0) FROM model_usage m WHERE m.session_id = s.id) AS output_tokens,
          (SELECT COALESCE(SUM(m.reasoning_tokens), 0) FROM model_usage m WHERE m.session_id = s.id) AS reasoning_tokens,
          (SELECT COALESCE(SUM(m.cache_read_input_tokens), 0) FROM model_usage m WHERE m.session_id = s.id) AS cache_read_tokens,
          (SELECT COALESCE(SUM(m.retry_count), 0) FROM model_usage m WHERE m.session_id = s.id) AS retry_count,
          (SELECT COALESCE(SUM(CASE WHEN m.error_type = 'rate_limited' THEN 1 ELSE 0 END), 0) FROM model_usage m WHERE m.session_id = s.id) AS rate_limit_count
        FROM session s
        WHERE s.parent_id = '${sessionId}'
        ORDER BY s.time_created DESC
        LIMIT 40;
      `),
      queryJson(`
        SELECT COUNT(*) AS cnt
        FROM tool_usage
        WHERE session_id = '${sessionId}'
          AND tool_name = 'Agent'
          AND status = 'running';
      `),
      queryJson(`
        SELECT
          m.session_id,
          m.duration_ms,
          m.time_to_first_token_ms,
          m.first_token_at,
          m.completed_at,
          m.output_tokens,
          m.retry_count,
          m.error_type
        FROM model_usage m
        JOIN session s ON s.id = m.session_id
        WHERE s.parent_id = '${sessionId}'
          AND m.status = 'completed'
        ORDER BY COALESCE(m.completed_at, m.started_at) ASC;
      `),
    ]);

    const parentRunningAgentCalls = Number(parentAgentRows[0]?.cnt || 0);
    const tpsByChild = new Map();
    for (const mr of childModelRows) {
      const tps = computeRowTps(mr);
      if (tps === null) continue;
      if (!tpsByChild.has(mr.session_id)) tpsByChild.set(mr.session_id, []);
      tpsByChild.get(mr.session_id).push(tps);
    }

    const currentMs = now();
    const totals = {
      requestCount: 0,
      toolCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
    };

    const items = [];
    for (const child of childRows) {
      const reqs = Number(child.reqs || 0);
      const tools = Number(child.tools || 0);
      const runningTools = Number(child.running_tools || 0);
      const inputTokens = Number(child.input_tokens || 0);
      const outputTokens = Number(child.output_tokens || 0);
      const reasoningTokens = Number(child.reasoning_tokens || 0);
      const cacheReadTokens = Number(child.cache_read_tokens || 0);

      totals.requestCount += reqs;
      totals.toolCount += tools;
      totals.inputTokens += inputTokens;
      totals.outputTokens += outputTokens;
      totals.reasoningTokens += reasoningTokens;
      totals.cacheReadTokens += cacheReadTokens;

      const createdAt = Number(child.time_created || 0);
      const lastActivityAt = Math.max(
        Number(child.time_updated || 0),
        Number(child.last_model_at || 0),
        Number(child.last_tool_at || 0),
        createdAt,
      );
      const activeRecently = lastActivityAt > 0 && (currentMs - lastActivityAt) < SUBAGENT_ACTIVITY_WINDOW_MS;

      let status = "completed";
      if (child.last_outcome === "error" || child.turn_status === "error") {
        status = "error";
      } else if (child.last_outcome === "cancelled" || child.turn_status === "cancelled") {
        status = "cancelled";
      } else if (
        child.last_outcome === null &&
        (parentRunningAgentCalls > 0 || runningTools > 0 || activeRecently)
      ) {
        status = "running";
      }

      const tpsList = tpsByChild.get(child.id) || [];
      const elapsedMs = createdAt > 0
        ? Math.max(0, (status === "running" ? currentMs : lastActivityAt) - createdAt)
        : 0;

      items.push({
        id: String(child.id),
        shortId: String(child.id).replace(/^sess_subagent_agent_/, "").slice(0, 8),
        title: cleanSubagentTitle(child.title, child.id),
        status,
        reqs,
        tools,
        runningTools,
        lastTool: child.last_tool ? String(child.last_tool) : null,
        inputTokens,
        outputTokens,
        reasoningTokens,
        cacheReadTokens,
        retryCount: Number(child.retry_count || 0),
        rateLimitCount: Number(child.rate_limit_count || 0),
        medianTps: median(tpsList),
        lastTps: tpsList.length ? tpsList[tpsList.length - 1] : null,
        elapsedMs,
        timeCreated: createdAt,
        lastActivityAt,
      });
    }

    items.sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (b.status === "running" && a.status !== "running") return 1;
      return b.timeCreated - a.timeCreated;
    });

    const runningCount = items.filter((item) => item.status === "running").length;
    return {
      runningCount,
      totalCount: items.length,
      parentRunningAgentCalls,
      totals,
      items: items.slice(0, SUBAGENT_DISPLAY_LIMIT),
    };
  }

  async function getModelBenchmarks(range = "today", sessionId = null) {
    const conditions = ["status IN ('completed', 'error')"];
    if (range === "session") {
      if (!isValidSessionId(sessionId)) return [];
      conditions.push(`session_id = '${sessionId}'`);
    } else {
      const cutoff = rangeCutoffMs(range, now());
      if (cutoff > 0) {
        conditions.push(`started_at >= ${Math.floor(cutoff)}`);
      }
    }

    const rows = await queryJson(`
      SELECT
        model_id,
        provider_id,
        status,
        duration_ms,
        time_to_first_token_ms,
        first_token_at,
        completed_at,
        input_tokens,
        output_tokens,
        reasoning_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        provider_total_tokens,
        computed_total_tokens,
        retry_count,
        error_type
      FROM model_usage
      WHERE ${conditions.join(" AND ")}
      ORDER BY started_at DESC
      LIMIT 2000;
    `);

    const byModel = new Map();
    for (const row of rows) {
      const key = String(row.model_id || "unknown");
      if (!byModel.has(key)) byModel.set(key, []);
      byModel.get(key).push(row);
    }

    const benchmarks = [];
    for (const [modelId, group] of byModel.entries()) {
      const summary = summarizeModelRows(group);
      benchmarks.push({
        modelId,
        providerId: String(group[0]?.provider_id || ""),
        ...summary,
      });
    }

    benchmarks.sort((a, b) => b.requestCount - a.requestCount);
    return benchmarks;
  }

  async function getOverview(sessionId, range = "today") {
    const [session, turnProfile, benchmarks, subagents] = await Promise.all([
      getSessionStats(sessionId),
      getTurnProfile(sessionId),
      getModelBenchmarks(range, sessionId),
      getSubagents(sessionId),
    ]);

    if (subagents.totals.requestCount > 0) {
      session.subagent = {
        ...session.subagent,
        requestCount: session.subagent.requestCount + subagents.totals.requestCount,
        inputTokens: session.subagent.inputTokens + subagents.totals.inputTokens,
        outputTokens: session.subagent.outputTokens + subagents.totals.outputTokens,
        reasoningTokens: session.subagent.reasoningTokens + subagents.totals.reasoningTokens,
        cacheReadTokens: session.subagent.cacheReadTokens + subagents.totals.cacheReadTokens,
      };
    }

    return {
      dbPath,
      range,
      session,
      turnProfile,
      benchmarks,
      subagents,
    };
  }

  return {
    getSessionStats,
    getTurnProfile,
    getSubagents,
    getModelBenchmarks,
    getOverview,
  };
}

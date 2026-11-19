export const MIN_VALID_DECODE_MS = 300;
export const MIN_VALID_OUTPUT_TOKENS = 20;
export const MAX_PLAUSIBLE_TPS = 800;
export const WARMUP_MS = 450;

const DEFAULT_ALPHA = 0.22;
const DEFAULT_HISTORY_LIMIT = 40;
const MAX_TRACKED_SESSIONS = 64;

function createEmptyEntry(sessionId) {
  return {
    sessionId,
    phase: "idle",
    streamChannel: null,
    activeToolName: null,
    requestId: null,
    model: null,
    rawTps: null,
    emaTps: null,
    peakTps: 0,
    lastOutputTokens: null,
    lastTtftMs: null,
    lastUpdatedAt: null,
    requestStartedAt: null,
    validSampleCount: 0,
    recentRaw: [],
    baselineTps: null,
    lastValidTps: null,
    history: [],
  };
}

function cloneEntry(entry) {
  return {
    sessionId: entry.sessionId,
    phase: entry.phase,
    streamChannel: entry.streamChannel,
    activeToolName: entry.activeToolName,
    requestId: entry.requestId,
    model: entry.model ? { ...entry.model } : null,
    rawTps: entry.rawTps,
    emaTps: entry.emaTps,
    peakTps: entry.peakTps,
    lastOutputTokens: entry.lastOutputTokens,
    lastTtftMs: entry.lastTtftMs,
    lastUpdatedAt: entry.lastUpdatedAt,
    baselineTps: entry.baselineTps,
    lastValidTps: entry.lastValidTps,
    history: entry.history.map((item) => ({ ...item })),
  };
}

function isValidNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

export function createThroughputTracker(options = {}) {
  const alpha = typeof options.alpha === "number" && options.alpha > 0 && options.alpha <= 1
    ? options.alpha
    : DEFAULT_ALPHA;
  const historyLimit = typeof options.historyLimit === "number" && options.historyLimit > 0
    ? Math.floor(options.historyLimit)
    : DEFAULT_HISTORY_LIMIT;
  const now = typeof options.now === "function" ? options.now : () => Date.now();

  const entries = new Map();

  function getOrCreate(sessionId) {
    let entry = entries.get(sessionId);
    if (entry) {
      entries.delete(sessionId);
      entries.set(sessionId, entry);
      return entry;
    }
    if (entries.size >= MAX_TRACKED_SESSIONS) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey !== undefined) entries.delete(oldestKey);
    }
    entry = createEmptyEntry(sessionId);
    entries.set(sessionId, entry);
    return entry;
  }

  function recomputeBaseline(entry) {
    const vals = entry.history
      .map((item) => item.tps)
      .filter((v) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_PLAUSIBLE_TPS);
    entry.baselineTps = median(vals);
  }

  function pushHistory(entry, sample) {
    const idx = entry.history.findIndex((item) => item.requestId === sample.requestId);
    if (idx >= 0) {
      entry.history[idx] = { ...entry.history[idx], ...sample };
    } else {
      entry.history.push(sample);
      if (entry.history.length > historyLimit) {
        entry.history.splice(0, entry.history.length - historyLimit);
      }
    }
    recomputeBaseline(entry);
  }

  function applyFilteredSample(entry, tps, ts, channel, toolName) {
    entry.recentRaw.push(tps);
    if (entry.recentRaw.length > 3) {
      entry.recentRaw.shift();
    }
    const med = median(entry.recentRaw) ?? tps;
    entry.phase = "streaming";
    entry.streamChannel = channel;
    entry.activeToolName = toolName;
    entry.rawTps = tps;
    entry.emaTps = entry.emaTps == null ? med : alpha * med + (1 - alpha) * entry.emaTps;
    entry.validSampleCount += 1;
    entry.lastValidTps = entry.emaTps;
    entry.lastUpdatedAt = ts;
    entry.peakTps = Math.max(entry.peakTps, med);
  }

  function recordStreamSample(sessionId, { tps, channel = "tool_input", toolName = null } = {}) {
    if (!sessionId || !Number.isFinite(tps) || tps <= 0 || tps > MAX_PLAUSIBLE_TPS) {
      return sessionId ? get(sessionId) : null;
    }
    const entry = getOrCreate(sessionId);
    const ts = now();

    if (entry.phase !== "streaming") {
      entry.recentRaw = [];
      entry.emaTps = entry.emaTps ?? entry.baselineTps ?? entry.lastValidTps ?? null;
    }

    applyFilteredSample(entry, tps, ts, channel, toolName);
    return cloneEntry(entry);
  }

  function markIdle(sessionId) {
    if (!sessionId) return null;
    const entry = getOrCreate(sessionId);
    entry.phase = "idle";
    entry.streamChannel = null;
    entry.activeToolName = null;
    entry.recentRaw = [];
    return cloneEntry(entry);
  }

  function recordEvent(event) {
    if (!event || typeof event.sessionId !== "string" || !event.sessionId) {
      return null;
    }
    const entry = getOrCreate(event.sessionId);
    const ts = now();
    const tps = isValidNumber(event.outputTokensPerSecond) ? event.outputTokensPerSecond : 0;
    const model = event.model
      ? { providerId: String(event.model.providerId || ""), modelId: String(event.model.modelId || "") }
      : entry.model;

    if (event.phase === "streaming") {
      const isNewRequest = entry.requestId !== event.requestId;
      if (isNewRequest) {
        entry.requestId = event.requestId;
        entry.requestStartedAt = ts;
        entry.recentRaw = [];
        entry.validSampleCount = 0;
        entry.lastOutputTokens = null;
        entry.lastTtftMs = null;
        entry.emaTps = entry.baselineTps ?? entry.lastValidTps ?? null;
      }

      entry.phase = "streaming";
      entry.streamChannel = "model";
      entry.activeToolName = null;
      entry.model = model;
      entry.lastUpdatedAt = ts;

      if (!Number.isFinite(tps) || tps <= 0 || tps > MAX_PLAUSIBLE_TPS) {
        return cloneEntry(entry);
      }

      const inWarmup = entry.requestStartedAt !== null
        && (ts - entry.requestStartedAt) < WARMUP_MS
        && entry.validSampleCount === 0;

      if (inWarmup) {
        if (tps > 400) {
          return cloneEntry(entry);
        }
        const anchor = entry.baselineTps ?? entry.lastValidTps;
        entry.rawTps = tps;
        entry.emaTps = anchor !== null ? 0.25 * tps + 0.75 * anchor : tps;
        entry.recentRaw.push(tps);
        entry.validSampleCount += 1;
        entry.lastValidTps = entry.emaTps;
        if (anchor === null) {
          entry.peakTps = Math.max(entry.peakTps, tps);
        }
        return cloneEntry(entry);
      }

      applyFilteredSample(entry, tps, ts, "model", null);
      return cloneEntry(entry);
    }

    if (event.phase === "final") {
      const outTokens = isValidNumber(event.outputTokens) ? event.outputTokens : null;
      const ttftMs = isValidNumber(event.timeToFirstTokenMs) ? event.timeToFirstTokenMs : null;
      const impliedDecodeMs = outTokens !== null && outTokens > 0 && tps > 0
        ? (outTokens / tps) * 1000
        : null;

      const isPlausible = tps > 0
        && tps <= MAX_PLAUSIBLE_TPS
        && (outTokens === null || outTokens >= MIN_VALID_OUTPUT_TOKENS)
        && (impliedDecodeMs === null || impliedDecodeMs >= MIN_VALID_DECODE_MS);

      entry.phase = "final";
      entry.streamChannel = null;
      entry.activeToolName = null;
      entry.requestId = event.requestId;
      entry.model = model;
      entry.lastUpdatedAt = ts;
      if (outTokens !== null) entry.lastOutputTokens = outTokens;
      if (ttftMs !== null) entry.lastTtftMs = ttftMs;

      if (isPlausible) {
        entry.rawTps = tps;
        entry.emaTps = tps;
        entry.lastValidTps = tps;
        entry.peakTps = Math.max(entry.peakTps, tps);

        pushHistory(entry, {
          requestId: event.requestId,
          modelId: model?.modelId || "",
          tps,
          ttftMs,
          outputTokens: outTokens,
          phase: "final",
          at: ts,
        });
      } else {
        const fallback = entry.lastValidTps ?? entry.baselineTps ?? null;
        entry.rawTps = fallback;
        entry.emaTps = fallback;
      }

      return cloneEntry(entry);
    }

    return cloneEntry(entry);
  }

  function hydrateHistory(sessionId, rows) {
    if (!sessionId || !Array.isArray(rows) || rows.length === 0) {
      return get(sessionId);
    }
    const entry = getOrCreate(sessionId);
    const existingIds = new Set(entry.history.map((item) => item.requestId));

    const historical = [];
    for (const row of rows) {
      if (!row || !row.requestId || existingIds.has(row.requestId)) continue;
      if (!isValidNumber(row.tps) || row.tps <= 0 || row.tps > MAX_PLAUSIBLE_TPS) continue;
      historical.push({
        requestId: String(row.requestId),
        modelId: String(row.modelId || ""),
        tps: row.tps,
        ttftMs: isValidNumber(row.ttftMs) ? row.ttftMs : null,
        outputTokens: isValidNumber(row.outputTokens) ? row.outputTokens : null,
        phase: "final",
        at: isValidNumber(row.completedAt) ? row.completedAt : 0,
      });
    }

    if (historical.length > 0) {
      const merged = [...historical, ...entry.history];
      entry.history = merged.slice(-historyLimit);
      recomputeBaseline(entry);
      const maxHist = Math.max(...entry.history.map((h) => h.tps));
      if (maxHist > entry.peakTps) entry.peakTps = maxHist;
    }

    if (entry.phase === "idle" && entry.requestId === null && entry.history.length > 0) {
      const latest = entry.history[entry.history.length - 1];
      entry.requestId = latest.requestId;
      entry.model = latest.modelId ? { providerId: "", modelId: latest.modelId } : null;
      entry.rawTps = latest.tps;
      entry.emaTps = latest.tps;
      entry.lastValidTps = latest.tps;
      entry.lastOutputTokens = latest.outputTokens;
      entry.lastTtftMs = latest.ttftMs;
      entry.lastUpdatedAt = latest.at || now();
    }

    return cloneEntry(entry);
  }

  function get(sessionId) {
    if (!sessionId) return createEmptyEntry("");
    const entry = entries.get(sessionId);
    return entry ? cloneEntry(entry) : createEmptyEntry(sessionId);
  }

  function clear(sessionId) {
    entries.delete(sessionId);
  }

  return {
    recordEvent,
    recordStreamSample,
    markIdle,
    hydrateHistory,
    get,
    clear,
  };
}
